"""Evidence pack for an alarm: what the signals were doing, against their normal ranges.

Everything here is computed from the sensor data and the detector's scores. No
LLM is involved; the pack is what the LLM is later asked to explain.

    python -m faultline.evidence     # writes the evidence part of results/alerts/<id>.json
"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd

from faultline.alarms import _runs, to_seconds
from faultline.config import REPO_ROOT, RESULTS_DIR
from faultline.data import ANALOG_SIGNALS, DIGITAL_SIGNALS, load
from faultline.eda import UNITS
from faultline.evaluate import ALARMS_JSON, BENCH_JSON, faultline_score
from faultline.profile import compressor_state, load_profile
from faultline.train import SCORES_PATH

ALERTS_DIR = RESULTS_DIR / "alerts"
ASSET = "Air production unit (oil-lubricated compressor with twin-tower dryer), Porto metro train, MetroPT-3 recording"

WINDOW_MIN = 60
TOP_SIGNALS = 4


def r(value: float, digits: int = 2) -> float | None:
    return None if value is None or not np.isfinite(value) else round(float(value), digits)


def stats(values: np.ndarray) -> dict | None:
    if len(values) == 0:
        return None
    return {"mean": r(values.mean()), "min": r(values.min()), "max": r(values.max())}


def verdict(mean: float | None, lo: float | None, hi: float | None) -> str:
    if mean is None or lo is None or hi is None:
        return "unknown"
    if mean > hi:
        return "above normal"
    if mean < lo:
        return "below normal"
    return "within normal"


def build_evidence(df: pd.DataFrame, scores: pd.DataFrame, score: pd.Series, alarm: dict,
                   threshold: float, profile: dict) -> dict:
    fire = pd.Timestamp(alarm["fire"])
    onset = pd.Timestamp(alarm["onset"])
    start = fire - pd.Timedelta(minutes=WINDOW_MIN)
    win = df.loc[start:fire]
    ts = to_seconds(win.index)
    current = win["Motor_current"].to_numpy()
    state = compressor_state(current)
    loaded = state == 2

    signals = {}
    for sig in ANALOG_SIGNALS:
        values = win[sig].to_numpy()
        normal = profile["signals"][sig]
        entry = {
            "unit": UNITS[sig],
            "window": stats(values),
            "normal_p05_p95": [normal["overall"]["p05"], normal["overall"]["p95"]],
        }
        if loaded.sum() >= 6:
            under = stats(values[loaded])
            lo, hi = normal["loaded"]["p05"], normal["loaded"]["p95"]
            entry["under_load"] = {
                **under,
                "normal_p05_p95": [lo, hi],
                "verdict": verdict(under["mean"], lo, hi),
            }
        signals[sig] = entry

    top = [
        {
            "signal": c["signal"],
            "share_of_error": c["share"],
            **signals[c["signal"]],
        }
        for c in alarm["top_signals"][:TOP_SIGNALS]
    ]

    # Compressor duty: how long it has been under load, and how often it starts.
    starts, ends, on = _runs(ts, loaded)
    run_min = (ts[ends] - ts[starts])[on] / 60.0
    current_run_min = 0.0
    if len(on) and on[-1]:
        # The run may have begun before the window: look further back for its start.
        back = df.loc[fire - pd.Timedelta(hours=72) : fire]
        b_ts = to_seconds(back.index)
        b_starts, b_ends, b_on = _runs(b_ts, compressor_state(back["Motor_current"].to_numpy()) == 2)
        current_run_min = float((b_ts[b_ends[-1]] - b_ts[b_starts[-1]]) / 60.0)
    last30 = loaded[ts >= ts[-1] - 1800]
    win2h = df.loc[fire - pd.Timedelta(hours=2) : fire]
    loaded2h = compressor_state(win2h["Motor_current"].to_numpy()) == 2
    s2, _, on2 = _runs(to_seconds(win2h.index), loaded2h)

    duty = {
        "under_load_share_last_30min": r(last30.mean(), 3),
        "under_load_share_last_60min": r(loaded.mean(), 3),
        "under_load_share_last_2h": r(loaded2h.mean(), 3),
        "normal_under_load_share_30min": profile["duty_30min"],
        "continuous_load_minutes_at_alarm": r(current_run_min, 1),
        "longest_loaded_run_minutes_last_60min": r(run_min.max(), 1) if len(run_min) else 0.0,
        "normal_loaded_run_minutes": profile["loaded_run_minutes"],
        "load_starts_last_2h": int(on2.sum()),
        "normal_starts_per_hour": profile["starts_per_hour"],
        "state_share_last_60min": {
            name: r((state == i).mean(), 3) for i, name in enumerate(("off", "offloaded", "loaded"))
        },
    }

    digital = {}
    for sig in DIGITAL_SIGNALS:
        values = win[sig].to_numpy()
        digital[sig] = {
            "share_on_last_60min": r(values.mean(), 3),
            "normal_share_on": profile["digital_share_on"][sig],
            "switches_last_60min": int(np.abs(np.diff(values.astype(int))).sum()),
        }

    day = df.loc[fire - pd.Timedelta(hours=24) : fire]
    trend = {
        "oil_temperature_max_last_60min": r(win["Oil_temperature"].max()),
        "oil_temperature_mean_previous_24h": r(day["Oil_temperature"].mean()),
        "reservoir_pressure_min_last_60min": r(win["Reservoirs"].min()),
        "under_load_share_previous_24h": r(
            (compressor_state(day["Motor_current"].to_numpy()) == 2).mean(), 3
        ),
    }

    at_fire = score.loc[:fire].iloc[-1]
    expected_rows = WINDOW_MIN * 6
    return {
        "alarm_id": alarm["id"],
        "asset": ASSET,
        "fired_at": alarm["fire"],
        "anomaly_began": alarm["onset"],
        "minutes_from_onset_to_alarm": r((fire - onset).total_seconds() / 60, 1),
        "window": {"start": str(start), "end": str(fire), "minutes": WINDOW_MIN},
        "detector": {
            "score_at_alarm": r(at_fire, 4),
            "threshold": r(threshold, 4),
            "score_over_threshold": r(at_fire / threshold, 2),
        },
        "top_contributing_signals": top,
        "signals": signals,
        "compressor_duty": duty,
        "digital_signals": digital,
        "trend": trend,
        "data_quality": {
            "rows_in_window": len(win),
            # Samples arrive every 9 to 13 s, so a fully logged hour can hold a few more
            # than 360 rows.
            "share_of_window_logged": r(min(1.0, len(win) / expected_rows), 2),
        },
    }


def load_alert(alarm_id: str) -> dict:
    return json.loads((ALERTS_DIR / f"{alarm_id}.json").read_text())


def save_alert(alert: dict) -> None:
    ALERTS_DIR.mkdir(parents=True, exist_ok=True)
    (ALERTS_DIR / f"{alert['alarm']['id']}.json").write_text(
        json.dumps(alert, indent=1, ensure_ascii=False) + "\n"
    )


def write_index() -> list[dict]:
    """results/alerts/index.json: one summary row per alert, for the app's lists."""
    rows = []
    for path in sorted(ALERTS_DIR.glob("A*.json")):
        a = json.loads(path.read_text())
        exp = a.get("explanation")
        rows.append(
            {
                "id": a["alarm"]["id"],
                "fire": a["alarm"]["fire"],
                "end": a["alarm"]["end"],
                "attribution": a["alarm"]["attribution"],
                "during_sustained_load": a["alarm"]["during_sustained_load"],
                "top_signals": [s["signal"] for s in a["alarm"]["top_signals"][:3]],
                "summary": exp["summary"] if exp else None,
                "priority": (a.get("work_order") or {}).get("priority"),
                "has_explanation": exp is not None,
            }
        )
    (ALERTS_DIR / "index.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False) + "\n")
    return rows


def main() -> int:
    df = load()
    scores = pd.read_parquet(SCORES_PATH)
    score = faultline_score(scores)
    bench = json.loads(BENCH_JSON.read_text())
    threshold = next(m for m in bench["methods"] if m["key"] == "faultline")["params"]["threshold"]
    alarms = json.loads(ALARMS_JSON.read_text())["alarms"]
    profile = load_profile()

    ALERTS_DIR.mkdir(parents=True, exist_ok=True)
    keep = {a["id"] for a in alarms}
    for stale in ALERTS_DIR.glob("A*.json"):
        if stale.stem not in keep:
            stale.unlink()

    for alarm in alarms:
        evidence = build_evidence(df, scores, score, alarm, threshold, profile)
        path = ALERTS_DIR / f"{alarm['id']}.json"
        alert = json.loads(path.read_text()) if path.exists() else {}
        # A changed alarm invalidates whatever explanation was cached for it.
        if alert.get("alarm") != alarm or alert.get("evidence") != evidence:
            alert = {"alarm": alarm, "evidence": evidence, "explanation": None, "work_order": None,
                     "chat_examples": [], "retrieval": None, "llm": None}
        save_alert(alert)
    rows = write_index()
    print(f"wrote evidence for {len(rows)} alarms to {ALERTS_DIR.relative_to(REPO_ROOT)}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
