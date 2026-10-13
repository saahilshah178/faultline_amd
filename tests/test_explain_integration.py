"""End-to-end run of the explainer against a local stand-in for the two vLLM servers.

The stand-in speaks the OpenAI HTTP API on localhost. Everything it produces is
synthetic and is written only to a temporary directory; nothing here touches
results/. The point is to exercise the real client, retrieval, validation,
retry, file writing and summary code before any GPU time is spent.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from types import SimpleNamespace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pytest

from faultline import evidence, explain, kb, llm
from faultline.config import RESULTS_DIR

API_KEY = "test-key"
DIM = 16


def fake_vector(text: str) -> list[float]:
    seed = int.from_bytes(hashlib.sha256(text.encode()).digest()[:8], "little")
    return np.random.default_rng(seed).normal(size=DIM).tolist()


def excerpts_in(prompt: str) -> list[tuple[str, int, str]]:
    return [
        (doc, int(page), body.strip())
        for doc, page, body in re.findall(
            r"\[excerpt \d+\] doc=(\S+) page=(\d+)\n(.*?)(?=\n\n\[excerpt |\Z)", prompt, flags=re.S
        )
    ]


def passage(text: str, words: int = 12) -> str:
    return " ".join(text.split()[2 : 2 + words])


class Handler(BaseHTTPRequestHandler):
    state: dict = {}

    def log_message(self, *args):  # keep pytest output clean
        pass

    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorised(self) -> bool:
        if self.headers.get("Authorization") == f"Bearer {API_KEY}":
            return True
        self._send(401, {"error": "unauthorised"})
        return False

    def do_POST(self):
        if not self._authorised():
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path.endswith("/embeddings"):
            self.state["embedded"] = self.state.get("embedded", 0) + len(body["input"])
            self.state.setdefault("embed_inputs", []).extend(body["input"])
            self._send(200, {"data": [{"index": i, "embedding": fake_vector(t)} for i, t in enumerate(body["input"])]})
            return
        self.state.setdefault("chat_bodies", []).append(body)
        system = body["messages"][0]["content"]
        context = body["messages"][1]["content"]
        found = excerpts_in(context)
        manual = next(e for e in found if e[0] == "doe-sourcebook")
        unit = next(e for e in found if e[0] == "apu-description")
        if "draft maintenance work orders" in system:
            content = json.dumps({
                "title": "Inspect air circuit for leak", "asset": "Air production unit",
                "symptom": "Compressor under load continuously", "suspected_cause": "Air leak",
                "steps": ["Isolate the unit", "Inspect the dryer drain", "Leak-test fittings", "Confirm cycling resumes"],
                "parts_to_check": ["Dryer drain valve"], "priority": "P2", "priority_reason": "Sustained load",
            })
        elif "helping a technician" in system:
            content = f"Start at the dryer drain valve [doe-sourcebook p.{manual[1]}]."
        else:
            # First explanation attempt per alarm fabricates a quote, to exercise the retry.
            alarm = re.search(r'"alarm_id": "(A\d+)"', context).group(1)
            first = alarm not in self.state.setdefault("seen", set())
            self.state["seen"].add(alarm)
            quote = "this sentence is not in the manual at all, it was made up" if first else passage(manual[2])
            content = json.dumps({
                "summary": "The compressor is running under load without cycling.",
                "likely_causes": [{"cause": "Air leak", "evidence": "under load far above normal", "confidence": "medium"}],
                "recommended_actions": [
                    {"action": "Leak-test the circuit", "why": "find the loss", "urgency": "now"},
                    {"action": "Check the dryer drain", "why": "may be stuck open", "urgency": "this_shift"},
                ],
                "citations": [
                    {"doc": "doe-sourcebook", "page": manual[1], "quote": quote},
                    {"doc": "apu-description", "page": unit[1], "quote": passage(unit[2])},
                ],
            })
        self._send(200, {
            "model": body["model"],
            "choices": [{"message": {"role": "assistant", "content": content, "reasoning": "thinking"},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1000, "completion_tokens": 200},
        })


@pytest.fixture
def servers():
    Handler.state = {}
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}/v1", Handler.state
    server.shutdown()


needs_alerts = pytest.mark.skipif(
    not (RESULTS_DIR / "alerts" / "index.json").exists() or not kb.CHUNKS_JSON.exists(),
    reason="needs results/alerts and results/kb/chunks.json",
)


@needs_alerts
def test_explain_end_to_end_against_a_local_stand_in(servers, tmp_path, monkeypatch):
    url, state = servers
    alerts_dir = tmp_path / "alerts"
    alerts_dir.mkdir()
    monkeypatch.setattr(kb, "EMBEDDINGS_BIN", tmp_path / "embeddings.f32")
    monkeypatch.setattr(kb, "EMBEDDINGS_META", tmp_path / "embeddings.json")
    monkeypatch.setattr(evidence, "ALERTS_DIR", alerts_dir)
    monkeypatch.setattr(explain, "ALERTS_DIR", alerts_dir)
    monkeypatch.setattr(explain, "LLM_SUMMARY", tmp_path / "summary.json")

    # Two real evidence packs, copied into the temp dir with their LLM fields empty.
    index = json.loads((RESULTS_DIR / "alerts" / "index.json").read_text())
    ids = [row["id"] for row in index[:2]]
    for alarm_id in ids:
        alert = json.loads((RESULTS_DIR / "alerts" / f"{alarm_id}.json").read_text())
        alert.update(explanation=None, work_order=None, chat_examples=[], retrieval=None, llm=None)
        (alerts_dir / f"{alarm_id}.json").write_text(json.dumps(alert))

    embedder = llm.EmbedClient(base_url=url, api_key=API_KEY, model="embed")
    chunks = kb.load_chunks()
    monkeypatch.setattr(llm, "EmbedClient", lambda: embedder)
    vectors = kb.embed_chunks(chunks)
    assert vectors.shape == (len(chunks), DIM)
    assert np.allclose(np.linalg.norm(kb.load_embeddings(), axis=1), 1.0, atol=1e-5)
    assert not any(t.startswith("Instruct:") for t in state["embed_inputs"]), "documents carry no instruction"

    client = llm.LLMClient(base_url=url, api_key=API_KEY, model="openai/gpt-oss-120b", log_path=tmp_path / "calls.jsonl")
    retriever = explain.Retriever(embedder, chunks, kb.load_embeddings())
    for alert in explain.load_alerts():
        evidence.save_alert(explain.explain_alert(alert, retriever, client))
    evidence_index = evidence.write_index()

    # Queries, unlike documents, carry the instruction prefix.
    assert any(t.startswith("Instruct:") and "\nQuery:" in t for t in state["embed_inputs"])
    # gpt-oss requests ask for low reasoning effort and a JSON schema for structured calls.
    structured = [b for b in state["chat_bodies"] if "response_format" in b]
    assert structured and all(b["reasoning_effort"] == "low" for b in state["chat_bodies"])
    assert structured[0]["response_format"]["json_schema"]["strict"] is True

    for alarm_id in ids:
        alert = json.loads((alerts_dir / f"{alarm_id}.json").read_text())
        assert alert["llm"]["explanation_attempts"] == 2, "the fabricated citation was rejected once"
        assert alert["llm"]["citations_validated"] is True
        assert explain.explanation_problems(alert["explanation"], alert["retrieval"]["excerpts"]) == []
        assert alert["work_order"]["priority"] == "P2"
        assert len(alert["chat_examples"]) == len(explain.FOLLOW_UPS)
        assert all(qa["citations"] for qa in alert["chat_examples"])
        # 1 rejected + 1 accepted explanation, 1 work order, 3 chat answers
        assert len(alert["llm"]["calls"]) == 6
        assert alert["llm"]["completion_tokens"] == 6 * 200
    assert all(row["has_explanation"] and row["summary"] for row in evidence_index)

    log = [json.loads(line) for line in (tmp_path / "calls.jsonl").read_text().splitlines()]
    assert len(log) == 12 and {r["purpose"] for r in log} == {"explain", "work_order", "chat"}
    assert all(r["latency_s"] > 0 and r["completion_tokens"] == 200 for r in log)

    summary = explain.summarise_log(batch_wall_s=30.0, n_alerts=2)
    assert summary["alerts"] == 2 and summary["calls"] == 12
    assert summary["calls_rejected_and_retried"] == 2
    assert summary["tokens_per_s"]["median"] > 0
    # The stand-in answers in milliseconds, so the cost rounds to almost nothing; check the arithmetic.
    seconds = [json.loads(p.read_text())["llm"]["llm_seconds"] for p in sorted(alerts_dir.glob("A*.json"))]
    expected = round(float(np.mean(seconds)) * summary["gpu_price"]["usd_per_hour"] / 3600, 4)
    assert summary["usd_per_alert"]["one_at_a_time"] == expected
    assert summary["batch"]["usd_per_alert"] == round(30.0 * summary["gpu_price"]["usd_per_hour"] / 3600 / 2, 4)


def test_client_rejects_a_wrong_key(servers):
    url, _ = servers
    client = llm.LLMClient(base_url=url, api_key="wrong", model="m", log_path=None)
    with pytest.raises(Exception, match="401"):
        client.chat([{"role": "user", "content": "hi"}], purpose="test")


def test_unconfigured_client_says_what_to_do(monkeypatch):
    blank = SimpleNamespace(llm_url="", embed_url="", vllm_api_key="", llm_model="m", embed_model="e",
                            llm_reasoning_effort="low")
    monkeypatch.setattr(llm, "settings", blank)
    with pytest.raises(llm.LLMNotConfigured, match="remote_setup.sh"):
        llm.LLMClient()
    with pytest.raises(llm.LLMNotConfigured, match="EMBED_URL"):
        llm.EmbedClient()
