"""Explain each alarm and draft its work order with the LLM served on the MI300X.

    python -m faultline.explain                 # every alarm that has no explanation yet
    python -m faultline.explain --force         # regenerate all
    python -m faultline.explain --only A003     # one alarm
    python -m faultline.explain --check         # verify every alarm has a valid explanation

For each alarm: retrieve manual excerpts for its evidence pack, ask the LLM for a
structured explanation, and reject and retry any answer whose citations do not
appear verbatim in the retrieved excerpts. Then draft a work order and answer a
few standard technician questions, so replay mode has real model output to show.
"""

from __future__ import annotations

import argparse
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

import jsonschema
import numpy as np

from faultline import kb
from faultline.config import PROMPTS_DIR, REPO_ROOT, RESULTS_DIR
from faultline.evidence import ALERTS_DIR, save_alert, write_index
from faultline.llm import LLM_LOG, ChatResult, EmbedClient, LLMClient, extract_json

LLM_SUMMARY = RESULTS_DIR / "llm" / "summary.json"

TOP_K = 8
MAX_ATTEMPTS = 4
MIN_QUOTE_WORDS = 6

FOLLOW_UPS = (
    "What should I check first when I get to the unit?",
    "How can I confirm whether this is an air leak, and where it is?",
    "What is the risk of leaving this until the next scheduled maintenance?",
)

CHAT_CITATION = re.compile(r"\[(doe-sourcebook|apu-description) p\.\s?(\d+)\]")


def prompt(name: str) -> str:
    return (PROMPTS_DIR / f"{name}.md").read_text().strip()


def schema(name: str) -> dict:
    return json.loads((PROMPTS_DIR / "schemas" / f"{name}.schema.json").read_text())


# --- Retrieval ---------------------------------------------------------------


def retrieval_queries(evidence: dict) -> list[str]:
    """Search queries derived from the evidence pack. Deterministic, no LLM."""
    duty = evidence["compressor_duty"]
    signals = evidence["signals"]
    top = {s["signal"] for s in evidence["top_contributing_signals"]}
    queries = ["compressed air system leaks: how to detect, locate and repair them"]

    normal_duty = duty["normal_under_load_share_30min"]["p95"]
    if (duty["under_load_share_last_30min"] or 0) > normal_duty:
        queries.append("compressor runs loaded continuously and does not unload or reach cut-out pressure")
        queries.append("compressor controls: load/unload operation and excessive run time")

    def above(sig: str) -> bool:
        return signals[sig].get("under_load", {}).get("verdict") == "above normal"

    if "DV_pressure" in top or above("DV_pressure"):
        queries.append("air dryer purge air and condensate drain valve stuck open wasting compressed air")
    if "Oil_temperature" in top or (evidence["trend"]["oil_temperature_max_last_60min"] or 0) > signals[
        "Oil_temperature"
    ]["normal_p05_p95"][1]:
        queries.append("high compressor oil or discharge temperature: causes and maintenance")
    if "H1" in top or "TP2" in top:
        queries.append("separator, filter and compressor discharge pressure problems, pressure drop across components")
    if (evidence["trend"]["reservoir_pressure_min_last_60min"] or 99) < signals["Reservoirs"]["normal_p05_p95"][0]:
        queries.append("low system pressure and pressure drop: causes and troubleshooting")
    if "Motor_current" in top:
        queries.append("compressor motor load, current draw and power at full load versus unloaded")
    queries.append("preventive maintenance checklist for rotary screw compressor and air dryer")
    return queries


class Retriever:
    """Cosine search over the embedded manual, plus the always-included unit description."""

    def __init__(self, embedder: EmbedClient, chunks: list[dict] | None = None,
                 vectors: np.ndarray | None = None):
        self.embedder = embedder
        self.chunks = chunks if chunks is not None else kb.load_chunks()
        self.vectors = vectors if vectors is not None else kb.load_embeddings()
        if len(self.chunks) != len(self.vectors):
            raise RuntimeError("chunks and embeddings are out of sync: run python -m faultline.kb --embed")
        self.unit = [c for c in self.chunks if c["doc"] == kb.APU["doc"]]
        self._manual = np.array([i for i, c in enumerate(self.chunks) if c["doc"] != kb.APU["doc"]])

    def search(self, queries: list[str], k: int = TOP_K) -> list[dict]:
        q = self.embedder.embed_queries(queries)
        sims = (self.vectors[self._manual] @ q.T).max(axis=1)
        order = np.argsort(-sims)[:k]
        return [{**self.chunks[self._manual[i]], "similarity": round(float(sims[i]), 4)} for i in order]

    def excerpts_for(self, queries: list[str], k: int = TOP_K) -> list[dict]:
        return self.search(queries, k) + self.unit


def format_excerpts(excerpts: list[dict]) -> str:
    return "\n\n".join(
        f"[excerpt {i}] doc={e['doc']} page={e['page']}\n{e['text']}" for i, e in enumerate(excerpts, start=1)
    )


# --- Validation --------------------------------------------------------------


def normalize(text: str) -> str:
    text = text.replace("­", "")
    for a, b in (("‘", "'"), ("’", "'"), ("“", '"'), ("”", '"'),
                 ("–", "-"), ("—", "-"), ("‑", "-"), (" ", " ")):
        text = text.replace(a, b)
    text = re.sub(r"\s+", " ", text).strip().lower()
    # A word the PDF broke across a line ("com- pressed") matches its repaired form.
    text = re.sub(r"(\w)- (\w)", r"\1\2", text)
    return text.strip(" \"'.,;:")


def citation_problems(citations: list[dict], excerpts: list[dict]) -> list[str]:
    problems = []
    pages = {(e["doc"], e["page"]) for e in excerpts}
    for i, c in enumerate(citations, start=1):
        quote = normalize(c.get("quote", ""))
        where = f"{c.get('doc')} page {c.get('page')}"
        if (c.get("doc"), c.get("page")) not in pages:
            problems.append(f"citation {i}: {where} is not one of the excerpts you were given")
        elif len(quote.split()) < MIN_QUOTE_WORDS:
            problems.append(f"citation {i}: the quote is too short; copy at least 8 consecutive words")
        elif not any(
            e["doc"] == c["doc"] and e["page"] == c["page"] and quote in normalize(e["text"]) for e in excerpts
        ):
            problems.append(
                f"citation {i}: the quote does not appear word for word in an excerpt from {where}; "
                "copy one contiguous passage exactly"
            )
    if not any(c.get("doc") == kb.DOE["doc"] for c in citations):
        problems.append("at least one citation must come from doc doe-sourcebook")
    return problems


def explanation_problems(explanation: dict, excerpts: list[dict]) -> list[str]:
    try:
        jsonschema.validate(explanation, schema("explanation"))
    except jsonschema.ValidationError as exc:
        return [f"schema: {exc.message}"]
    return citation_problems(explanation["citations"], excerpts)


def chat_problems(answer: str, excerpts: list[dict]) -> list[str]:
    pages = {(e["doc"], e["page"]) for e in excerpts}
    bad = sorted({f"[{d} p.{p}]" for d, p in CHAT_CITATION.findall(answer) if (d, int(p)) not in pages})
    return [f"these citations are not among the excerpts: {', '.join(bad)}"] if bad else []


# --- Generation --------------------------------------------------------------


def _call_record(purpose: str, r: ChatResult, attempt: int) -> dict:
    return {
        "purpose": purpose,
        "attempt": attempt,
        "latency_s": round(r.latency_s, 3),
        "prompt_tokens": r.prompt_tokens,
        "completion_tokens": r.completion_tokens,
        "tokens_per_s": round(r.tokens_per_s, 2),
    }


def generate_validated(
    llm: LLMClient,
    messages: list[dict],
    *,
    purpose: str,
    alarm_id: str,
    problems_of,
    json_schema: dict | None,
    schema_name: str,
    calls: list[dict],
    max_tokens: int = 4096,
):
    """Ask, validate, and on rejection feed the problems back and ask again."""
    convo = list(messages)
    last_problems: list[str] = []
    for attempt in range(1, MAX_ATTEMPTS + 1):
        result = llm.chat(convo, purpose=purpose, alarm_id=alarm_id, json_schema=json_schema,
                          schema_name=schema_name, attempt=attempt, max_tokens=max_tokens)
        calls.append(_call_record(purpose, result, attempt))
        try:
            parsed = extract_json(result.content) if json_schema is not None else result.content.strip()
            last_problems = problems_of(parsed)
        except json.JSONDecodeError:
            parsed, last_problems = None, ["the reply was not a single valid JSON object"]
        if not last_problems:
            return parsed, attempt
        convo = [
            *messages,
            {"role": "assistant", "content": result.content},
            {
                "role": "user",
                "content": "Your reply was rejected for these reasons:\n- "
                + "\n- ".join(last_problems)
                + "\nCorrect them and send the complete reply again.",
            },
        ]
    raise RuntimeError(f"{alarm_id} {purpose}: still invalid after {MAX_ATTEMPTS} attempts: {last_problems}")


def evidence_block(evidence: dict) -> str:
    return "ALARM EVIDENCE (JSON):\n" + json.dumps(evidence, ensure_ascii=False)


def explain_alert(alert: dict, retriever: Retriever, llm: LLMClient) -> dict:
    alarm_id = alert["alarm"]["id"]
    evidence = alert["evidence"]
    calls: list[dict] = []
    t0 = time.perf_counter()

    queries = retrieval_queries(evidence)
    excerpts = retriever.excerpts_for(queries)
    excerpt_text = format_excerpts(excerpts)

    explanation, attempts = generate_validated(
        llm,
        [
            {"role": "system", "content": prompt("explain_system")},
            {"role": "user", "content": f"{evidence_block(evidence)}\n\nREFERENCE EXCERPTS:\n{excerpt_text}"},
        ],
        purpose="explain",
        alarm_id=alarm_id,
        problems_of=lambda parsed: explanation_problems(parsed, excerpts),
        json_schema=schema("explanation"),
        schema_name="alarm_explanation",
        calls=calls,
    )

    def work_order_problems(parsed: dict) -> list[str]:
        try:
            jsonschema.validate(parsed, schema("work_order"))
        except jsonschema.ValidationError as exc:
            return [f"schema: {exc.message}"]
        return []

    work_order, _ = generate_validated(
        llm,
        [
            {"role": "system", "content": prompt("workorder_system")},
            {
                "role": "user",
                "content": f"{evidence_block(evidence)}\n\nEXPLANATION (JSON):\n"
                f"{json.dumps(explanation, ensure_ascii=False)}\n\nREFERENCE EXCERPTS:\n{excerpt_text}",
            },
        ],
        purpose="work_order",
        alarm_id=alarm_id,
        problems_of=work_order_problems,
        json_schema=schema("work_order"),
        schema_name="work_order",
        calls=calls,
    )

    alert["explanation"] = explanation
    alert["work_order"] = work_order
    alert["retrieval"] = {
        "queries": queries,
        "excerpts": [
            {k: e[k] for k in ("id", "doc", "page", "printed_page", "text")}
            | ({"similarity": e["similarity"]} if "similarity" in e else {})
            for e in excerpts
        ],
    }
    alert["chat_examples"] = [
        answer_question(alert, question, retriever, llm, calls=calls) for question in FOLLOW_UPS
    ]

    wall = time.perf_counter() - t0
    out_tokens = sum(c["completion_tokens"] for c in calls)
    gen_seconds = sum(c["latency_s"] for c in calls)
    alert["llm"] = {
        "model": llm.model,
        "generated_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "explanation_attempts": attempts,
        "citations_validated": True,
        "calls": calls,
        "wall_seconds": round(wall, 2),
        "llm_seconds": round(gen_seconds, 2),
        "prompt_tokens": sum(c["prompt_tokens"] for c in calls),
        "completion_tokens": out_tokens,
        "tokens_per_s": round(out_tokens / gen_seconds, 2) if gen_seconds else None,
    }
    return alert


def answer_question(
    alert: dict,
    question: str,
    retriever: Retriever,
    llm: LLMClient,
    history: list[dict] | None = None,
    calls: list[dict] | None = None,
) -> dict:
    """Technician follow-up: same evidence, retrieval refreshed for the question."""
    calls = calls if calls is not None else []
    excerpts = retriever.excerpts_for([question, *alert["retrieval"]["queries"][:2]], k=6)
    context = (
        f"{evidence_block(alert['evidence'])}\n\nEXPLANATION (JSON):\n"
        f"{json.dumps(alert['explanation'], ensure_ascii=False)}\n\nWORK ORDER (JSON):\n"
        f"{json.dumps(alert['work_order'], ensure_ascii=False)}\n\nREFERENCE EXCERPTS:\n"
        f"{format_excerpts(excerpts)}"
    )
    messages = [
        {"role": "system", "content": prompt("chat_system")},
        {"role": "user", "content": context},
        {"role": "assistant", "content": "Understood. What is your question?"},
        *(history or []),
        {"role": "user", "content": question},
    ]
    answer, _ = generate_validated(
        llm,
        messages,
        purpose="chat",
        alarm_id=alert["alarm"]["id"],
        problems_of=lambda text: chat_problems(text, excerpts),
        json_schema=None,
        schema_name="",
        calls=calls,
        max_tokens=2048,
    )
    cited = sorted({(d, int(p)) for d, p in CHAT_CITATION.findall(answer)})
    return {
        "question": question,
        "answer": answer,
        "citations": [
            {"doc": d, "page": p, "chunk_ids": [e["id"] for e in excerpts if e["doc"] == d and e["page"] == p]}
            for d, p in cited
        ],
    }


# --- Batch -------------------------------------------------------------------


def load_alerts() -> list[dict]:
    return [json.loads(p.read_text()) for p in sorted(ALERTS_DIR.glob("A*.json"))]


def check() -> int:
    """Stage check: every alarm has an explanation whose citations validate."""
    alarms = json.loads((RESULTS_DIR / "alarms.json").read_text())["alarms"]
    failures = []
    for alarm in alarms:
        path = ALERTS_DIR / f"{alarm['id']}.json"
        if not path.exists():
            failures.append(f"{alarm['id']}: no alert file")
            continue
        alert = json.loads(path.read_text())
        if not alert.get("explanation") or not alert.get("work_order"):
            failures.append(f"{alarm['id']}: no explanation or work order")
            continue
        problems = explanation_problems(alert["explanation"], alert["retrieval"]["excerpts"])
        failures += [f"{alarm['id']}: {p}" for p in problems]
        for qa in alert["chat_examples"]:
            failures += [f"{alarm['id']} chat: {p}" for p in chat_problems(qa["answer"], alert["retrieval"]["excerpts"] + [])]
    if failures:
        print(f"FAIL: {len(failures)} problem(s)")
        for line in failures[:40]:
            print("  " + line)
        return 1
    print(f"ok: {len(alarms)} alarms, each with an explanation, a work order and validated citations")
    return 0


def summarise_log(batch_wall_s: float | None, n_alerts: int) -> dict:
    """Aggregate results/llm/calls.jsonl and the per-alert stats into results/llm/summary.json."""
    from faultline.config import gpu_pricing

    alerts = [a for a in load_alerts() if a.get("llm")]
    calls = [c for a in alerts for c in a["llm"]["calls"]]
    out_tokens = sum(c["completion_tokens"] for c in calls)
    llm_seconds = sum(c["latency_s"] for c in calls)
    per_alert_seconds = [a["llm"]["llm_seconds"] for a in alerts]
    tps = sorted(c["tokens_per_s"] for c in calls if c["completion_tokens"] >= 50)
    price = gpu_pricing()
    summary = {
        "generated_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model": alerts[0]["llm"]["model"] if alerts else None,
        "alerts": len(alerts),
        "calls": len(calls),
        "calls_rejected_and_retried": sum(c["attempt"] > 1 for c in calls),
        "prompt_tokens": sum(c["prompt_tokens"] for c in calls),
        "completion_tokens": out_tokens,
        "tokens_per_s": {
            "note": "completion tokens divided by end-to-end request latency, per call",
            "median": round(float(np.median(tps)), 1) if tps else None,
            "p10": round(float(np.quantile(tps, 0.10)), 1) if tps else None,
            "p90": round(float(np.quantile(tps, 0.90)), 1) if tps else None,
            "aggregate": round(out_tokens / llm_seconds, 1) if llm_seconds else None,
        },
        "seconds_per_alert": {
            "note": "sum of LLM request latencies for one alert (explanation, work order, 3 chat answers)",
            "median": round(float(np.median(per_alert_seconds)), 1) if per_alert_seconds else None,
            "max": round(float(np.max(per_alert_seconds)), 1) if per_alert_seconds else None,
        },
        "gpu_price": price,
        "usd_per_alert": None,
        "batch": None,
    }
    if per_alert_seconds and price["usd_per_hour"]:
        summary["usd_per_alert"] = {
            "one_at_a_time": round(float(np.mean(per_alert_seconds)) * price["usd_per_hour"] / 3600, 4),
            "note": "GPU rental for the LLM seconds one alert takes when processed alone",
        }
        if batch_wall_s and n_alerts:
            summary["batch"] = {
                "alerts": n_alerts,
                "wall_seconds": round(batch_wall_s, 1),
                "usd_per_alert": round(batch_wall_s * price["usd_per_hour"] / 3600 / n_alerts, 4),
                "note": "wall-clock time of the concurrent batch divided across its alerts",
            }
    LLM_SUMMARY.parent.mkdir(parents=True, exist_ok=True)
    LLM_SUMMARY.write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="regenerate even if cached")
    parser.add_argument("--only", nargs="*", help="alarm ids to process")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)

    if args.check:
        return check()

    alerts = load_alerts()
    todo = [
        a for a in alerts
        if (not args.only or a["alarm"]["id"] in args.only) and (args.force or not a.get("explanation"))
    ]
    if not todo:
        print("nothing to do: every alarm already has an explanation (use --force to regenerate)")
        return check()

    if args.force and not args.only and LLM_LOG.exists():
        LLM_LOG.unlink()
    llm = LLMClient()
    retriever = Retriever(EmbedClient())
    print(f"explaining {len(todo)} alarm(s) with {llm.model}, concurrency {args.concurrency}")

    def work(alert: dict) -> str:
        save_alert(explain_alert(alert, retriever, llm))
        stats = alert["llm"]
        return (f"  {alert['alarm']['id']}: {stats['llm_seconds']:.1f}s, {stats['completion_tokens']} tokens, "
                f"{stats['tokens_per_s']} tok/s, explanation attempts {stats['explanation_attempts']}")

    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        for line in pool.map(work, todo):
            print(line)
    wall = time.perf_counter() - t0

    write_index()
    summary = summarise_log(wall, len(todo))
    print(f"done in {wall:.0f}s; median {summary['tokens_per_s']['median']} tok/s; "
          f"wrote {LLM_SUMMARY.relative_to(REPO_ROOT)}")
    return check()


if __name__ == "__main__":
    raise SystemExit(main())
