"""Clients for the two vLLM servers on the MI300X (OpenAI-compatible HTTP).

Every chat call is timed and appended to results/llm/calls.jsonl with its token
counts, so tokens per second and cost per alert come from logged runs.
"""

from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import httpx
import numpy as np

from faultline.config import RESULTS_DIR, settings

LLM_LOG = RESULTS_DIR / "llm" / "calls.jsonl"

# Qwen3-Embedding is instruction-aware: queries carry a task instruction, documents do not.
QUERY_INSTRUCTION = (
    "Given a maintenance question about an industrial compressed air system, "
    "retrieve passages from the manual that help answer it"
)

_log_lock = threading.Lock()


class LLMNotConfigured(RuntimeError):
    pass


def _require(value: str, name: str) -> str:
    if not value:
        raise LLMNotConfigured(
            f"{name} is not set. Bring the droplet up with scripts/remote_setup.sh and put "
            f"{name} in .env (see .env.example)."
        )
    return value


@dataclass
class ChatResult:
    content: str
    reasoning: str | None
    prompt_tokens: int
    completion_tokens: int
    latency_s: float
    model: str
    finish_reason: str | None = None
    raw: dict = field(default_factory=dict, repr=False)

    @property
    def tokens_per_s(self) -> float:
        return self.completion_tokens / self.latency_s if self.latency_s > 0 else 0.0


def extract_json(text: str) -> dict:
    """Parse a JSON object from model output, tolerating code fences or stray prose."""
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, flags=re.DOTALL)
    if fenced:
        return json.loads(fenced.group(1))
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        return json.loads(text[start : end + 1])
    raise json.JSONDecodeError("no JSON object in model output", text, 0)


class LLMClient:
    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        model: str | None = None,
        log_path: Path | None = LLM_LOG,
        timeout_s: float = 300.0,
    ):
        self.base_url = _require(base_url or settings.llm_url, "LLM_URL").rstrip("/")
        self.api_key = _require(api_key or settings.vllm_api_key, "VLLM_API_KEY")
        self.model = model or settings.llm_model
        self.log_path = log_path
        self._http = httpx.Client(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=httpx.Timeout(timeout_s, connect=15.0),
        )

    def chat(
        self,
        messages: list[dict],
        *,
        purpose: str,
        alarm_id: str | None = None,
        json_schema: dict | None = None,
        schema_name: str = "response",
        max_tokens: int = 4096,
        temperature: float = 0.2,
        attempt: int = 1,
    ) -> ChatResult:
        body: dict = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if settings.llm_reasoning_effort and "gpt-oss" in self.model:
            body["reasoning_effort"] = settings.llm_reasoning_effort
        if json_schema is not None:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": schema_name, "schema": json_schema, "strict": True},
            }
        # vLLM occasionally fails a gpt-oss request with a Harmony parsing error
        # (HTTP 5xx). One immediate retry clears it; the failed try is not timed.
        for tries_left in (2, 1, 0):
            t0 = time.perf_counter()
            resp = self._http.post("/chat/completions", json=body)
            latency = time.perf_counter() - t0
            if resp.status_code < 500 or tries_left == 0:
                break
        resp.raise_for_status()
        data = resp.json()
        choice = data["choices"][0]
        message = choice["message"]
        usage = data.get("usage") or {}
        result = ChatResult(
            content=message.get("content") or "",
            # vLLM renamed reasoning_content to reasoning; accept either.
            reasoning=message.get("reasoning") or message.get("reasoning_content"),
            prompt_tokens=int(usage.get("prompt_tokens", 0)),
            completion_tokens=int(usage.get("completion_tokens", 0)),
            latency_s=latency,
            model=data.get("model", self.model),
            finish_reason=choice.get("finish_reason"),
            raw=data,
        )
        self._log(purpose, alarm_id, attempt, result)
        return result

    def _log(self, purpose: str, alarm_id: str | None, attempt: int, r: ChatResult) -> None:
        if self.log_path is None:
            return
        record = {
            "utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "purpose": purpose,
            "alarm_id": alarm_id,
            "attempt": attempt,
            "model": r.model,
            "latency_s": round(r.latency_s, 3),
            "prompt_tokens": r.prompt_tokens,
            "completion_tokens": r.completion_tokens,
            "tokens_per_s": round(r.tokens_per_s, 2),
            "finish_reason": r.finish_reason,
        }
        with _log_lock:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.log_path, "a") as f:
                f.write(json.dumps(record) + "\n")


class EmbedClient:
    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        model: str | None = None,
        timeout_s: float = 120.0,
    ):
        self.base_url = _require(base_url or settings.embed_url, "EMBED_URL").rstrip("/")
        self.api_key = _require(api_key or settings.vllm_api_key, "VLLM_API_KEY")
        self.model = model or settings.embed_model
        self._http = httpx.Client(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=httpx.Timeout(timeout_s, connect=15.0),
        )

    def _embed(self, texts: list[str], batch: int = 32) -> np.ndarray:
        vectors: list[list[float]] = []
        for i in range(0, len(texts), batch):
            resp = self._http.post("/embeddings", json={"model": self.model, "input": texts[i : i + batch]})
            resp.raise_for_status()
            items = sorted(resp.json()["data"], key=lambda d: d["index"])
            vectors.extend(item["embedding"] for item in items)
        return np.asarray(vectors, dtype=np.float32)

    def embed_documents(self, texts: list[str]) -> np.ndarray:
        return self._embed(texts)

    def embed_queries(self, queries: list[str]) -> np.ndarray:
        # Prefix format from the Qwen3-Embedding model card. vLLM does not add it.
        vectors = self._embed([f"Instruct: {QUERY_INSTRUCTION}\nQuery:{q}" for q in queries])
        return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
