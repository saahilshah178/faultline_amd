"""Evaluate the detector and the static-threshold baselines over the full timeline.

    python -m faultline.evaluate           # writes results/bench.json, bench.md, alarms.json
    python -m faultline.evaluate --check   # recompute and compare with the saved bench.json

Protocol (all of it fixed before looking at results, none of it uses failure data):

  * An alarm is the instant a score has stayed above its threshold for the minimum
    duration. Thresholds and durations come from `faultline.alarms.tune`, which
    reads pre-failure data only.
  * A failure is detected if an alarm fires between LEAD_HORIZON_H before the
    reported window starts and the end of the window (or the reported maintenance
    time, if later). Lead time is measured from the first such alarm.
  * Any alarm that fires outside those spans (plus POST_BUFFER_H after them) is a
    false alarm. False alarms per week are reported for the period from the first
    failure onward, which the tuning never saw.
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime

import numpy as np
import pandas as pd

from faultline import alarms as A
from faultline import baseline as B
from faultline.config import RESULTS_DIR
from faultline.data import ANALOG_SIGNALS, NOMINAL_INTERVAL_S, UCI_PAGE_URL, load
from faultline.detector import GAP_S
from faultline.failures import FIRST_FAILURE_START, Failure, load_failures
from faultline.train import SCORES_PATH, TRAIN_REPORT

BENCH_JSON = RESULTS_DIR / "bench.json"
BENCH_MD = RESULTS_DIR / "bench.md"
ALARMS_JSON = RESULTS_DIR / "alarms.json"

LEAD_HORIZON_H = 24
POST_BUFFER_H = 24
HORIZON_SENSITIVITY_H = (2, 6, 12, 24, 48, 72, 168)
SMOOTH = "2min"
WEEK_S = 7 * 24 * 3600


def iso(seconds: int | None) -> str | None:
    if seconds is None:
        return None
    return pd.Timestamp(seconds, unit="s").strftime("%Y-%m-%d %H:%M:%S")


def secs(ts: pd.Timestamp) -> int:
    return int(ts.value // 10**9)


def faultline_score(scores: pd.DataFrame) -> pd.Series:
    """Smoothed reconstruction error: mean over signals, then a 2-minute causal mean."""
    total = scores[[f"err_{s}" for s in ANALOG_SIGNALS]].mean(axis=1)
    return total.rolling(SMOOTH).mean()


def zones(failures: list[Failure], horizon_h: float) -> list[dict]:
    out = []
    for f in failures:
        detect_end = max(f.end, f.maintenance) if f.maintenance is not None else f.end
        out.append(
            {
                "id": f.id,
                "start": secs(f.start),
                "end": secs(f.end),
                "maintenance": secs(f.maintenance) if f.maintenance is not None else None,
                "zone_start": secs(f.start) - int(horizon_h * 3600),
                "detect_end": secs(detect_end),
                "zone_end": secs(detect_end) + POST_BUFFER_H * 3600,
            }
        )
    return out


def classify(fire: int, zs: list[dict]) -> str:
    for z in zs:
        if z["zone_start"] <= fire <= z["detect_end"]:
            return z["id"]
        if z["detect_end"] < fire <= z["zone_end"]:
            return f"buffer:{z['id']}"
    return "tuning_period" if fire < secs(FIRST_FAILURE_START) else "false_alarm"


def evaluation_period(ts: np.ndarray, zs: list[dict]) -> dict:
    """Time from the first failure onward that lies outside every failure zone."""
    start, end = secs(FIRST_FAILURE_START), int(ts[-1])
    excluded = 0
    cursor = start
    for z in sorted(zs, key=lambda z: z["zone_start"]):
        lo, hi = max(z["zone_start"], cursor), min(z["zone_end"], end)
        if hi > lo:
            excluded += hi - lo
            cursor = hi
    in_period = ts >= start
    outside = in_period.copy()
    for z in zs:
        outside &= ~((ts >= z["zone_start"]) & (ts <= z["zone_end"]))
    steps = np.diff(ts, append=ts[-1])
    observed = float(np.where(steps <= GAP_S, steps, NOMINAL_INTERVAL_S)[outside].sum())
    return {
        "start": iso(start),
        "end": iso(end),
        "calendar_weeks": round((end - start - excluded) / WEEK_S, 3),
        "observed_weeks": round(observed / WEEK_S, 3),
        "excluded_hours": round(excluded / 3600, 1),
    }


def failure_rows(fires: np.ndarray, zs: list[dict]) -> list[dict]:
    rows = []
    for z in zs:
        hits = fires[(fires >= z["zone_start"]) & (fires <= z["detect_end"])]
        first = int(hits.min()) if len(hits) else None
        row = {
            "id": z["id"],
            "window_start": iso(z["start"]),
            "window_end": iso(z["end"]),
            "maintenance": iso(z["maintenance"]),
            "detected": first is not None,
            "first_alarm": iso(first),
            "lead_before_start_h": None,
            "lead_before_maintenance_h": None,
            "first_alarm_after_window_end": None,
            "alarms_in_span": len(hits),
        }
        if first is not None:
            row["lead_before_start_h"] = round((z["start"] - first) / 3600, 3)
            row["first_alarm_after_window_end"] = bool(first > z["end"])
            if z["maintenance"] is not None:
                row["lead_before_maintenance_h"] = round((z["maintenance"] - first) / 3600, 3)
        rows.append(row)
    return rows


def summarise(episodes: list[A.Episode], zs: list[dict], period: dict, load_spans: np.ndarray) -> dict:
    fires = np.array([ep.fire for ep in episodes], dtype=np.int64)
    kinds = [classify(int(f), zs) for f in fires]
    rows = failure_rows(fires, zs)
    false_fires = [int(f) for f, k in zip(fires, kinds) if k == "false_alarm"]
    leads = [r["lead_before_start_h"] for r in rows if r["detected"]]
    n_false = len(false_fires)
    return {
        "failures": rows,
        "summary": {
            "failures_detected": sum(r["detected"] for r in rows),
            "failures_missed": sum(not r["detected"] for r in rows),
            "detected_before_window_start": sum(1 for x in leads if x > 0),
            "median_lead_before_start_h": round(float(np.median(leads)), 3) if leads else None,
            "alarms_total": len(episodes),
            "alarms_in_tuning_period": kinds.count("tuning_period"),
            "false_alarms": n_false,
            "false_alarms_per_week": round(n_false / period["calendar_weeks"], 3),
            "false_alarms_per_observed_week": round(n_false / period["observed_weeks"], 3),
            "false_alarms_during_sustained_load": sum(in_spans(f, load_spans) for f in false_fires),
        },
    }


def in_spans(t: int, spans: np.ndarray) -> bool:
    if len(spans) == 0:
        return False
    return bool(((spans[:, 0] <= t) & (t <= spans[:, 1] + A.PROXY_GRACE_S)).any())


def alarm_records(
    episodes: list[A.Episode],
    zs: list[dict],
    load_spans: np.ndarray,
    prefix: str,
    extra: list[dict] | None = None,
) -> list[dict]:
    out = []
    for i, ep in enumerate(episodes):
        rec = {
            "id": f"{prefix}{i + 1:03d}",
            "fire": iso(ep.fire),
            "onset": iso(ep.onset),
            "end": iso(ep.end),
            "active_minutes": round((ep.end - ep.fire) / 60, 1),
            "attribution": classify(ep.fire, zs),
            "during_sustained_load": in_spans(ep.fire, load_spans),
        }
        if extra:
            rec.update(extra[i])
        out.append(rec)
    return out


def contributions(scores: pd.DataFrame, ep: A.Episode) -> list[dict]:
    """Share of the reconstruction error each signal carried while the alarm built up."""
    span = scores.loc[pd.Timestamp(ep.onset, unit="s") : pd.Timestamp(ep.fire, unit="s")]
    err = span[[f"err_{s}" for s in ANALOG_SIGNALS]].mean(axis=0).to_numpy(dtype=np.float64)
    share = err / err.sum()
    order = np.argsort(-share)
    return [
        {"signal": ANALOG_SIGNALS[i], "share": round(float(share[i]), 4), "error": round(float(err[i]), 4)}
        for i in order
    ]


def build(scores_path=SCORES_PATH, train_report_path=TRAIN_REPORT) -> tuple[dict, list[dict]]:
    df = load()
    scores = pd.read_parquet(scores_path)
    failures = load_failures()
    train_report = json.loads(train_report_path.read_text())

    ts = A.to_seconds(df.index)
    is_pre = np.asarray(df.index < FIRST_FAILURE_START)
    pre = df.loc[is_pre]

    proxies = A.sustained_load_episodes(pre.index, pre["Motor_current"].to_numpy())
    load_spans = np.array(
        A.sustained_load_episodes(df.index, df["Motor_current"].to_numpy()), dtype=np.int64
    ).reshape(-1, 2)

    zs = zones(failures, LEAD_HORIZON_H)
    period = evaluation_period(ts, zs)

    # --- Faultline detector -------------------------------------------------
    score = faultline_score(scores)
    score_ts = A.to_seconds(score.index)
    score_pre = score.loc[score.index < FIRST_FAILURE_START]
    tuned = A.tune(score_pre.index, score_pre.to_numpy(), proxies)
    fl_eps = A.find_episodes(score_ts, score.to_numpy() > tuned.threshold, tuned.duration_s)
    fl_extra = [{"top_signals": contributions(scores, ep)} for ep in fl_eps]

    methods = []
    fl = {
        "key": "faultline",
        "label": "Faultline (conv autoencoder)",
        "kind": "detector",
        "params": {
            "threshold": round(tuned.threshold, 6),
            "threshold_quantile": tuned.quantile,
            "duration_s": tuned.duration_s,
            "smoothing": SMOOTH,
        },
        "tuning": {
            "feasible": tuned.feasible,
            "proxies_detected": tuned.proxies_detected,
            "proxies_total": tuned.proxies_total,
            "mean_delay_min": round(tuned.mean_delay_s / 60, 1),
            "other_alarms": tuned.other_alarms,
        },
        **summarise(fl_eps, zs, period, load_spans),
        "alarms": alarm_records(fl_eps, zs, load_spans, "A", fl_extra),
    }
    methods.append(fl)

    # --- Static thresholds --------------------------------------------------
    episode_sets: dict[str, list[A.Episode]] = {"faultline": fl_eps}
    for variant, label, params in (
        ("static_tuned", "Static thresholds, tuned like the detector", B.tune_rules(pre, proxies)),
        ("static_envelope", "Static thresholds at the pre-failure envelope", B.envelope_rules(pre)),
    ):
        per_rule = B.run_rules(df, params)
        merged = B.merge_episodes(per_rule)
        eps = [ep for ep, _ in merged]
        episode_sets[variant] = eps
        methods.append(
            {
                "key": variant,
                "label": label,
                "kind": "baseline",
                "params": {
                    rule: {**p, "threshold": round(p["threshold"], 4), "unit": B.RULES[rule]["unit"]}
                    for rule, p in params.items()
                },
                **summarise(eps, zs, period, load_spans),
                "rules": {
                    rule: {"label": B.RULES[rule]["label"], **summarise(r_eps, zs, period, load_spans)}
                    for rule, r_eps in per_rule.items()
                },
                "alarms": alarm_records(
                    eps, zs, load_spans, "S" if variant == "static_tuned" else "E",
                    [{"rules": rules} for _, rules in merged],
                ),
            }
        )

    # --- Sensitivity to the lead horizon ------------------------------------
    sensitivity = {}
    for h in HORIZON_SENSITIVITY_H:
        zs_h = zones(failures, h)
        period_h = evaluation_period(ts, zs_h)
        sensitivity[str(h)] = {}
        for key, eps in episode_sets.items():
            s = summarise(eps, zs_h, period_h, load_spans)
            sensitivity[str(h)][key] = {
                "failures_detected": s["summary"]["failures_detected"],
                "false_alarms": s["summary"]["false_alarms"],
                "false_alarms_per_week": s["summary"]["false_alarms_per_week"],
                "lead_before_start_h": {r["id"]: r["lead_before_start_h"] for r in s["failures"]},
            }

    hw = train_report["hardware"]
    bench = {
        "generated_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "dataset": {
            "name": "MetroPT-3",
            "source": UCI_PAGE_URL,
            "license": "CC BY 4.0",
            "rows": len(df),
            "start": str(df.index[0]),
            "end": str(df.index[-1]),
            "interval_s": NOMINAL_INTERVAL_S,
        },
        "protocol": {
            "training_cutoff": str(FIRST_FAILURE_START),
            "lead_horizon_h": LEAD_HORIZON_H,
            "post_buffer_h": POST_BUFFER_H,
            "alarm_clear_s": A.CLEAR_S,
            "tuning": {
                "data": f"before {FIRST_FAILURE_START}",
                "objective": "lowest mean delay to detect pre-failure sustained-load episodes",
                "max_other_alarms": A.MAX_OTHER_ALARMS,
                "delay_cap_s": A.DELAY_CAP_S,
                "sustained_load_min_s": A.SUSTAINED_LOAD_MIN_S,
                "loaded_current_a": A.LOADED_CURRENT_A,
                "quantiles": list(A.QUANTILES),
                "durations_s": list(A.DURATIONS_S),
            },
            "evaluation_period": period,
        },
        "pre_failure_sustained_load_episodes": [
            {"start": iso(s), "end": iso(e), "minutes": round((e - s) / 60, 1)} for s, e in proxies
        ],
        "sustained_load_episodes_total": len(load_spans),
        "training": {
            "hardware": hw,
            "trained_on_mi300x": bool(hw["device"] == "cuda" and "MI300" in (hw["gpu_name"] or "")),
            "train_seconds_total": train_report["train_seconds_total"],
            "train_seconds_final_model": train_report["train_seconds_final_model"],
            "score_windows_per_second": train_report["score_windows_per_second"],
            "parameters": train_report["parameters"],
            "windows_scored": train_report["windows_scored"],
            "share_of_rows_scored": train_report["share_of_rows_scored"],
            "config": train_report["config"],
            "run": train_report["run"],
        },
        "methods": methods,
        "sensitivity": {"lead_horizon_h": sensitivity},
    }
    return bench, fl["alarms"]


# --- Markdown report ---------------------------------------------------------


def fmt_lead(hours: float | None) -> str:
    if hours is None:
        return "missed"
    minutes = abs(hours) * 60
    size = f"{minutes:.0f} min" if minutes < 120 else f"{abs(hours):.1f} h"
    return f"{size} {'before' if hours > 0 else 'after'}"


def fmt_hours(hours: float | None) -> str:
    if hours is None:
        return "n/a"
    return f"{hours:.1f} h" if abs(hours) >= 2 else f"{hours * 60:.0f} min"


def markdown(bench: dict) -> str:
    methods = bench["methods"]
    proto = bench["protocol"]
    tr = bench["training"]
    hw = tr["hardware"]
    period = proto["evaluation_period"]
    lines = ["# Benchmark", ""]
    lines.append(
        f"Generated {bench['generated_utc']} by `python -m faultline.evaluate` from "
        f"`data/scores.parquet` and `results/train.json`. Do not edit by hand."
    )
    lines.append("")
    device = hw["gpu_name"] or hw["device"]
    where = "AMD Instinct MI300X" if tr["trained_on_mi300x"] else f"{device} (local development run, not the MI300X)"
    lines.append(
        f"Detector trained on: **{where}**, PyTorch {hw['torch']}"
        + (f", ROCm/HIP {hw['hip']}" if hw["hip"] else "")
        + f". Training time {tr['train_seconds_total']:.0f} s for {tr['config']['folds']} cross-fitting folds "
        f"plus the final model ({tr['train_seconds_final_model']:.0f} s for the final model alone); "
        f"{tr['parameters']:,} parameters."
    )
    lines += ["", "## First alarm relative to the start of each reported failure window", ""]
    lines.append("| Failure | Reported window (2020) | " + " | ".join(m["label"] for m in methods) + " |")
    lines.append("|---|---|" + "---|" * len(methods))
    for i, f in enumerate(methods[0]["failures"]):
        window = f"{f['window_start'][5:16]} to {f['window_end'][5:16]}"
        cells = [fmt_lead(m["failures"][i]["lead_before_start_h"]) for m in methods]
        lines.append(f"| {f['id']} | {window} | " + " | ".join(cells) + " |")
    lines += ["", "## Warning before the reported maintenance", ""]
    lines.append("| Failure | Maintenance | " + " | ".join(m["label"] for m in methods) + " |")
    lines.append("|---|---|" + "---|" * len(methods))
    for i, f in enumerate(methods[0]["failures"]):
        if f["maintenance"] is None:
            continue
        cells = [fmt_hours(m["failures"][i]["lead_before_maintenance_h"]) for m in methods]
        lines.append(f"| {f['id']} | {f['maintenance'][5:16]} | " + " | ".join(cells) + " |")
    lines += ["", "## Detection and false alarms", ""]
    lines.append("| | " + " | ".join(m["label"] for m in methods) + " |")
    lines.append("|---|" + "---|" * len(methods))

    def row(name: str, fn) -> None:
        lines.append(f"| {name} | " + " | ".join(str(fn(m["summary"])) for m in methods) + " |")

    row("Failures detected (of 4)", lambda s: s["failures_detected"])
    row("Detected before the window start", lambda s: s["detected_before_window_start"])
    row("False alarms", lambda s: s["false_alarms"])
    row("False alarms per week", lambda s: f"{s['false_alarms_per_week']:.2f}")
    row("False alarms per week of logged data", lambda s: f"{s['false_alarms_per_observed_week']:.2f}")
    row("False alarms during sustained compressor load", lambda s: s["false_alarms_during_sustained_load"])
    row("Alarms in the tuning period", lambda s: s["alarms_in_tuning_period"])
    lines += [
        "",
        f"False alarms are counted from {period['start'][:10]} to {period['end'][:10]}, outside the "
        f"failure spans: {period['calendar_weeks']:.1f} calendar weeks, {period['observed_weeks']:.1f} weeks of "
        "logged data. \"During sustained compressor load\" counts false alarms that fired while the "
        f"compressor had been under load for more than {proto['tuning']['sustained_load_min_s'] // 60} minutes "
        "without a break, the same behaviour as in the reported failures, on days with no failure report.",
        "",
        "## Settings chosen on pre-failure data",
        "",
    ]
    fl = methods[0]
    lines.append(
        f"- Faultline: score above {fl['params']['threshold']:.4f} (the {fl['params']['threshold_quantile']:.2%} "
        f"quantile of pre-failure scores) for {fl['params']['duration_s'] // 60} min."
    )
    for m in methods[1:]:
        parts = [
            f"{B.RULES[r]['label'].lower()} above {p['threshold']:g} {p['unit']} for {p['duration_s'] // 60} min"
            for r, p in m["params"].items()
        ]
        lines.append(f"- {m['label']}: " + "; ".join(parts) + ".")
    lines += ["", "## How each method did on the pre-failure data it was tuned on", ""]
    lines.append("| Method | Sustained-load episodes caught within 2 h | Mean delay | Other alarms |")
    lines.append("|---|---|---|---|")
    tuned_rows = [(fl["label"], fl["tuning"])]
    tuned = next(m for m in methods if m["key"] == "static_tuned")
    tuned_rows += [(f"Static: {B.RULES[r]['label'].lower()}", p["tuning"]) for r, p in tuned["params"].items()]
    for label, t in tuned_rows:
        lines.append(
            f"| {label} | {t['proxies_detected']} of {t['proxies_total']} | "
            f"{t['mean_delay_min']:.0f} min | {t['other_alarms']} |"
        )
    lines += [
        "",
        "Mean delay counts an episode that was not caught within 2 h as 2 h. The episodes are defined "
        "from motor current (under load for more than "
        f"{proto['tuning']['sustained_load_min_s'] // 60} minutes without a break), which favours the "
        "static motor-current rule: it is close to the definition itself.",
        "",
        "## The tuned static rules, one at a time",
        "",
        "| Rule | Failures detected | First alarm vs window start (F1 to F4) | False alarms | False alarms per week |",
        "|---|---|---|---|---|",
    ]
    for r, v in tuned["rules"].items():
        leads = ", ".join(fmt_lead(f["lead_before_start_h"]) for f in v["failures"])
        lines.append(
            f"| {v['label']} | {v['summary']['failures_detected']} | {leads} | "
            f"{v['summary']['false_alarms']} | {v['summary']['false_alarms_per_week']:.2f} |"
        )
    lines += [
        "",
        "## Protocol",
        "",
        f"- Training and tuning read only data before {proto['training_cutoff']}, the start of the first "
        "reported failure. The code enforces this (`assert_pre_failure`).",
        f"- The pre-failure data contains {len(bench['pre_failure_sustained_load_episodes'])} unreported "
        "episodes of sustained compressor load. Every method was tuned to detect those as early as possible "
        f"with at most {proto['tuning']['max_other_alarms']} other alarms in the pre-failure period.",
        f"- A failure counts as detected if an alarm fires from {proto['lead_horizon_h']} h before its window "
        "starts until the window ends (or the reported maintenance, if later). Alarms outside those spans, "
        f"and outside the {proto['post_buffer_h']} h after them, are false alarms.",
        f"- The detector needs {tr['config']['window'] * NOMINAL_INTERVAL_S // 60} minutes of unbroken data before "
        f"it can score, so it is blind for that long after every gap in the record; it scored "
        f"{tr['share_of_rows_scored']:.1%} of the rows.",
        "- The reported windows open within minutes of the compressor going into continuous load, so "
        "\"minutes after\" means minutes after the leak was already in full effect.",
        "- Four failures is a small sample. Treat every number here as a case study, not a rate.",
        "",
        "## Sensitivity to the lead horizon",
        "",
        "How the result changes if alarms further ahead of a failure are credited to it.",
        "",
        "| Horizon | " + " | ".join(f"{m['label']}: detected / false alarms per week" for m in methods) + " |",
        "|---|" + "---|" * len(methods),
    ]
    for h, by_method in bench["sensitivity"]["lead_horizon_h"].items():
        cells = [
            f"{by_method[m['key']]['failures_detected']} / {by_method[m['key']]['false_alarms_per_week']:.2f}"
            for m in methods
        ]
        lines.append(f"| {h} h | " + " | ".join(cells) + " |")
    lines.append("")
    return "\n".join(lines)


def strip_volatile(bench: dict) -> dict:
    """Drop what legitimately differs between two runs: timestamps and timings."""
    out = json.loads(json.dumps(bench))
    out.pop("generated_utc", None)
    for key in ("train_seconds_total", "train_seconds_final_model", "score_windows_per_second", "run"):
        out["training"].pop(key, None)
    return out


def differences(a, b, path: str = "") -> list[str]:
    """Paths at which two JSON values differ."""
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for key in sorted(set(a) | set(b)):
            out += differences(a.get(key), b.get(key), f"{path}.{key}" if path else key)
        return out
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        return [d for i, (x, y) in enumerate(zip(a, b)) for d in differences(x, y, f"{path}[{i}]")]
    return [] if a == b else [f"{path}: {a!r} != {b!r}"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="compare with the saved bench.json")
    parser.add_argument(
        "--from", dest="source", metavar="DIR",
        help="with --check: evaluate the scores.parquet and train.json of a fresh training run in DIR",
    )
    args = parser.parse_args(argv)

    if args.check:
        from pathlib import Path

        source = Path(args.source) if args.source else None
        bench, _ = build(source / "scores.parquet", source / "train.json") if source else build()
        saved = json.loads(BENCH_JSON.read_text())
        diffs = differences(strip_volatile(saved), strip_volatile(bench))
        what = f"a fresh training run in {source}" if source else "the saved scores"
        if diffs:
            print(f"MISMATCH: benchmark recomputed from {what} differs from results/bench.json in {len(diffs)} place(s)")
            for line in diffs[:25]:
                print("  " + line)
            return 1
        print(f"ok: benchmark recomputed from {what} matches results/bench.json")
        return 0

    bench, fl_alarms = build()
    RESULTS_DIR.mkdir(exist_ok=True)
    BENCH_JSON.write_text(json.dumps(bench, indent=2) + "\n")
    BENCH_MD.write_text(markdown(bench))
    ALARMS_JSON.write_text(json.dumps({"generated_utc": bench["generated_utc"], "alarms": fl_alarms}, indent=2) + "\n")

    for m in bench["methods"]:
        s = m["summary"]
        leads = ", ".join(f"{r['id']} {fmt_lead(r['lead_before_start_h'])}" for r in m["failures"])
        print(f"{m['label']}: {s['failures_detected']}/4 detected; {leads}; "
              f"{s['false_alarms']} false alarms ({s['false_alarms_per_week']:.2f}/week)")
    print(f"wrote {BENCH_JSON.name}, {BENCH_MD.name}, {ALARMS_JSON.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
