"""Keep the numbers in README.md and docs/submission.md in step with results/.

    python -m faultline.report           # rewrite the generated blocks
    python -m faultline.report --check   # fail if a block is stale

A generated block sits between `<!-- NAME:start -->` and `<!-- NAME:end -->`
markers. Nothing between the markers is written by hand, so every figure in
those documents traces back to a file under results/.
"""

from __future__ import annotations

import argparse
import json
import re

from faultline.config import REPO_ROOT, RESULTS_DIR
from faultline.evaluate import BENCH_JSON, BENCH_MD, fmt_hours, fmt_lead

LLM_SUMMARY = RESULTS_DIR / "llm" / "summary.json"
GPU_VRAM = RESULTS_DIR / "gpu" / "serving_vram.txt"
DOCUMENTS = [REPO_ROOT / "README.md", REPO_ROOT / "docs" / "submission.md"]


def _bench() -> dict:
    return json.loads(BENCH_JSON.read_text())


def _llm() -> dict | None:
    return json.loads(LLM_SUMMARY.read_text()) if LLM_SUMMARY.exists() else None


def _method(bench: dict, key: str) -> dict:
    return next(m for m in bench["methods"] if m["key"] == key)


def trained_on(bench: dict) -> str:
    tr = bench["training"]
    hw = tr["hardware"]
    if tr["trained_on_mi300x"]:
        return f"an AMD Instinct MI300X ({hw['gpu_name']}), PyTorch {hw['torch']} on ROCm (HIP {hw['hip']})"
    return f"`{hw['gpu_name'] or hw['device']}` (a local development run, not yet the MI300X)"


def block_status(bench: dict) -> str:
    """A plain statement of which numbers are final."""
    tr = bench["training"]
    llm = _llm()
    lines = []
    if tr["trained_on_mi300x"]:
        lines.append(
            f"The detector numbers below come from a run on {trained_on(bench)}, "
            f"finished {tr['run']['finished_utc']}."
        )
    else:
        lines.append(
            f"> **Status:** the detector numbers below come from a run on {trained_on(bench)} "
            f"(finished {tr['run']['finished_utc']}). `scripts/gpu_session.sh` reruns the same "
            "pipeline on the droplet and replaces them."
        )
    if llm is None:
        lines.append(
            "> The explanations, work orders, tokens per second and cost per alert are produced "
            "on the MI300X and are not in `results/` yet."
        )
    return "\n".join(lines)


def block_headline(bench: dict) -> str:
    fl, tuned, env = (_method(bench, k) for k in ("faultline", "static_tuned", "static_envelope"))
    period = bench["protocol"]["evaluation_period"]

    def leads(m: dict) -> str:
        return "; ".join(f"{f['id']} {fmt_lead(f['lead_before_start_h'])}" for f in m["failures"])

    rows = [
        "| | Failures detected | First alarm vs start of reported window | False alarms per week |",
        "|---|---|---|---|",
    ]
    for m in (fl, tuned, env):
        s = m["summary"]
        rows.append(
            f"| {m['label']} | {s['failures_detected']} of {len(m['failures'])} | {leads(m)} | "
            f"{s['false_alarms_per_week']:.2f} |"
        )
    maint = [
        f"{f['id']}: {fmt_hours(f['lead_before_maintenance_h'])}"
        for f in fl["failures"]
        if f["lead_before_maintenance_h"] is not None
    ]
    text = "\n".join(rows)
    text += (
        f"\n\nFalse alarms are counted over the {period['calendar_weeks']:.1f} weeks after the first "
        "failure that the tuning never saw. Where the operator recorded a maintenance time, "
        f"Faultline's first alarm came this long before it: {', '.join(maint)}."
    )
    return text


def block_bench_tables(bench: dict) -> str:
    """The result tables of results/bench.md, with headings moved one level down."""
    text = BENCH_MD.read_text()
    start = text.index("## First alarm relative")
    end = text.index("## Settings chosen on pre-failure data")
    return re.sub(r"^## ", "### ", text[start:end].strip(), flags=re.M)


def block_training(bench: dict) -> str:
    tr = bench["training"]
    cfg = tr["config"]
    return (
        f"Trained on {trained_on(bench)}. {cfg['folds']} cross-fitting folds plus the final model took "
        f"{tr['train_seconds_total']:.0f} s ({tr['train_seconds_final_model']:.0f} s for the final model); "
        f"{tr['parameters']:,} parameters, {cfg['epochs']} epochs, windows of {cfg['window']} samples "
        f"({cfg['window'] * bench['dataset']['interval_s'] // 60} min). Scoring ran at "
        f"{tr['score_windows_per_second']:,.0f} windows per second."
    )


def block_llm(bench: dict) -> str:
    llm = _llm()
    if llm is None:
        return (
            "Not measured yet. These figures are written to `results/llm/summary.json` by "
            "`python -m faultline.explain` when the droplet is up."
        )
    tps = llm["tokens_per_s"]
    price = llm["gpu_price"]
    lines = [
        f"- Model: `{llm['model']}` served by vLLM on the MI300X.",
        f"- {llm['alerts']} alarms explained with {llm['calls']} LLM calls; "
        f"{llm['calls_rejected_and_retried']} replies were rejected by validation and retried.",
        f"- Tokens per second (completion tokens over end-to-end request time): median {tps['median']}, "
        f"10th to 90th percentile {tps['p10']} to {tps['p90']}.",
        f"- LLM time per alarm (explanation, work order and three chat answers): median "
        f"{llm['seconds_per_alert']['median']} s.",
    ]
    if llm.get("usd_per_alert"):
        lines.append(
            f"- GPU cost per alarm at ${price['usd_per_hour']:.2f}/hour ({price['instance']}; "
            f"[price source]({price['source']})): ${llm['usd_per_alert']['one_at_a_time']:.4f} processed one "
            "at a time"
            + (
                f", ${llm['batch']['usd_per_alert']:.4f} in the concurrent batch."
                if llm.get("batch")
                else "."
            )
        )
    if GPU_VRAM.exists():
        vram = [line.strip() for line in GPU_VRAM.read_text().splitlines() if "GB used of" in line]
        if vram:
            lines.append(f"- GPU memory with both servers up: `{vram[0]}`.")
    return "\n".join(lines)


def block_pitch(bench: dict) -> str:
    """The sentences with numbers in them, for slides and the video script."""
    fl, tuned, env = (_method(bench, k) for k in ("faultline", "static_tuned", "static_envelope"))
    n = len(fl["failures"])
    llm = _llm()

    def leads(m: dict) -> str:
        return ", ".join(f"{f['id']} {fmt_lead(f['lead_before_start_h'])}" for f in m["failures"])

    maint = ", ".join(
        f"{fmt_hours(f['lead_before_maintenance_h'])} ({f['id']})"
        for f in fl["failures"]
        if f["lead_before_maintenance_h"] is not None
    )
    lines = [
        f"- Detected: Faultline {fl['summary']['failures_detected']} of {n} failures; conventional "
        f"envelope limits {env['summary']['failures_detected']} of {n}; static rules tuned the same way "
        f"{tuned['summary']['failures_detected']} of {n}.",
        f"- Faultline's first alarm against the start of each reported window: {leads(fl)}.",
        f"- Tuned static rules, same measure: {leads(tuned)}.",
        f"- Warning before the recorded maintenance: {maint}.",
        f"- False alarms per week after the first failure: Faultline {fl['summary']['false_alarms_per_week']:.2f}, "
        f"tuned static rules {tuned['summary']['false_alarms_per_week']:.2f}, envelope limits "
        f"{env['summary']['false_alarms_per_week']:.2f}. Of Faultline's {fl['summary']['false_alarms']} "
        f"false alarms, {fl['summary']['false_alarms_during_sustained_load']} fired during sustained "
        "compressor load on days with no failure report.",
        f"- Detector training took {bench['training']['train_seconds_total']:.0f} s on {trained_on(bench)}.",
    ]
    if llm is None:
        lines.append("- Tokens per second and GPU cost per alert: not measured yet (needs the MI300X run).")
    else:
        lines.append(
            f"- `{llm['model']}` on the MI300X: median {llm['tokens_per_s']['median']} tokens per second; "
            f"median {llm['seconds_per_alert']['median']} s of LLM time per alarm."
        )
        if llm.get("usd_per_alert"):
            lines.append(
                f"- GPU cost per alarm: ${llm['usd_per_alert']['one_at_a_time']:.4f} at "
                f"${llm['gpu_price']['usd_per_hour']:.2f}/hour."
            )
    return "\n".join(lines)


BLOCKS = {
    "pitch": block_pitch,
    "status": block_status,
    "headline": block_headline,
    "bench": block_bench_tables,
    "training": block_training,
    "llm": block_llm,
}


def render(text: str, bench: dict) -> str:
    for name, fn in BLOCKS.items():
        pattern = re.compile(rf"(<!-- {name}:start -->\n)(?:.*?\n)?(<!-- {name}:end -->)", flags=re.S)
        if pattern.search(text):
            body = fn(bench)
            text = pattern.sub(lambda m, body=body: f"{m.group(1)}{body}\n{m.group(2)}", text)
    return text


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)

    bench = _bench()
    stale = []
    for path in DOCUMENTS:
        if not path.exists():
            continue
        current = path.read_text()
        updated = render(current, bench)
        if updated != current:
            stale.append(path)
            if not args.check:
                path.write_text(updated)
    if args.check and stale:
        print("stale generated blocks in: " + ", ".join(str(p.relative_to(REPO_ROOT)) for p in stale))
        print("run: python -m faultline.report")
        return 1
    print("documents in step with results/" if not stale else
          "updated: " + ", ".join(str(p.relative_to(REPO_ROOT)) for p in stale))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
