"""Smoke test, run from the laptop: is the droplet serving both models?

Calls /v1/models on both vLLM servers, one chat completion on the LLM and one
embedding on the embedder. Exits non-zero on any failure.

    uv run python scripts/smoke.py
"""

from __future__ import annotations

import json
import sys
import time

import httpx

from faultline.config import settings


def _client(base_url: str) -> httpx.Client:
    return httpx.Client(
        base_url=base_url.rstrip("/"),
        headers={"Authorization": f"Bearer {settings.vllm_api_key}"},
        timeout=httpx.Timeout(180.0, connect=10.0),
    )


def check_models(name: str, base_url: str, expected: str) -> None:
    with _client(base_url) as c:
        r = c.get("/models")
        r.raise_for_status()
        ids = [m["id"] for m in r.json()["data"]]
    if expected not in ids:
        raise SystemExit(f"FAIL {name}: expected model {expected!r}, server has {ids}")
    print(f"ok   {name} /v1/models -> {ids}")


def check_chat() -> None:
    body = {
        "model": settings.llm_model,
        "messages": [
            {"role": "system", "content": "You are a terse assistant."},
            {"role": "user", "content": "Reply with exactly the word: pong"},
        ],
        # gpt-oss reasons before it answers, so leave room for that.
        "max_tokens": 1024,
        "temperature": 0,
    }
    if settings.llm_reasoning_effort and "gpt-oss" in settings.llm_model:
        body["reasoning_effort"] = settings.llm_reasoning_effort
    t0 = time.perf_counter()
    with _client(settings.llm_url) as c:
        r = c.post("/chat/completions", json=body)
        r.raise_for_status()
    dt = time.perf_counter() - t0
    data = r.json()
    msg = data["choices"][0]["message"]
    content = (msg.get("content") or "").strip()
    usage = data.get("usage", {})
    out_tokens = usage.get("completion_tokens", 0)
    if "pong" not in content.lower():
        raise SystemExit(f"FAIL chat: unexpected reply {json.dumps(msg)[:400]}")
    tps = out_tokens / dt if dt > 0 else float("nan")
    print(f"ok   chat -> {content!r} in {dt:.2f}s, {out_tokens} completion tokens, {tps:.1f} tok/s")


def check_embedding() -> None:
    body = {"model": settings.embed_model, "input": ["compressed air leak", "oil temperature"]}
    t0 = time.perf_counter()
    with _client(settings.embed_url) as c:
        r = c.post("/embeddings", json=body)
        r.raise_for_status()
    dt = time.perf_counter() - t0
    vecs = [d["embedding"] for d in r.json()["data"]]
    if len(vecs) != 2 or not vecs[0]:
        raise SystemExit("FAIL embedding: empty result")
    print(f"ok   embedding -> 2 vectors of dim {len(vecs[0])} in {dt:.2f}s")


def main() -> int:
    missing = [
        k
        for k, v in {
            "LLM_URL": settings.llm_url,
            "EMBED_URL": settings.embed_url,
            "VLLM_API_KEY": settings.vllm_api_key,
        }.items()
        if not v
    ]
    if missing:
        print(f"BLOCKED: {', '.join(missing)} not set in .env (see .env.example).")
        print("Create the MI300X droplet, set DROPLET_HOST, then run scripts/remote_setup.sh.")
        return 2
    check_models("llm", settings.llm_url, settings.llm_model)
    check_models("embed", settings.embed_url, settings.embed_model)
    check_chat()
    check_embedding()
    print("smoke passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
