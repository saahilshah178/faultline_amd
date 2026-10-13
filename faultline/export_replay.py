"""Export the sensor stream and detector output in the form the web app replays.

    python -m faultline.export_replay

Writes results/replay/:
    manifest.json          signals, failures, alarms per method, per-day summary
    days/YYYY-MM-DD.json   one-minute means of every analog signal, plus the detector score
    alarms/<id>.json       the 10-second data around each Faultline alarm, with per-signal error

Timestamps in MetroPT-3 are wall-clock times with no zone. They are exported as
unix seconds as if they were UTC; the app formats them as UTC to show the same
wall-clock time.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import numpy as np
import pandas as pd

from faultline.alarms import LOADED_CURRENT_A
from faultline.config import REPO_ROOT, RESULTS_DIR, SCORES_PATH
from faultline.data import ANALOG_SIGNALS, load
from faultline.eda import UNITS
from faultline.evaluate import BENCH_JSON, faultline_score
from faultline.failures import load_failures

REPLAY_DIR = RESULTS_DIR / "replay"
STEP_S = 60
ALARM_BEFORE = pd.Timedelta(hours=2)
ALARM_AFTER = pd.Timedelta(hours=1)

LABELS = {
    "TP2": "Compressor pressure (TP2)",
    "TP3": "Pneumatic panel pressure (TP3)",
    "H1": "Separator pressure (H1)",
    "DV_pressure": "Dryer discharge pressure (DV)",
    "Reservoirs": "Reservoir pressure",
    "Oil_temperature": "Oil temperature",
    "Motor_current": "Motor current",
}
DECIMALS = {"Oil_temperature": 1}


def epoch(ts: pd.Timestamp) -> int:
    return int(ts.value // 10**9)


def clean(values: np.ndarray, digits: int) -> list:
    """Round and turn NaN into null."""
    out = np.round(values.astype(np.float64), digits)
    return [None if not np.isfinite(v) else float(v) for v in out]


def write_json(path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":"), allow_nan=False) + "\n")


def export_days(df: pd.DataFrame, score: pd.Series) -> list[dict]:
    minute = df[ANALOG_SIGNALS].resample("1min").mean()
    loaded = (df["Motor_current"] > LOADED_CURRENT_A).astype("float32").resample("1min").mean()
    score_min = score.resample("1min").max().reindex(minute.index)
    rows = df["TP2"].resample("1min").count()

    out_dir = REPLAY_DIR / "days"
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("*.json"):
        stale.unlink()

    summary = []
    for day, block in minute.groupby(minute.index.normalize()):
        if block["TP2"].notna().sum() == 0:
            continue
        full = pd.date_range(day, periods=1440, freq="1min")
        block = block.reindex(full)
        day_loaded = loaded.reindex(full)
        day_score = score_min.reindex(full)
        name = day.strftime("%Y-%m-%d")
        write_json(
            out_dir / f"{name}.json",
            {
                "date": name,
                "t0": epoch(day),
                "step": STEP_S,
                "n": 1440,
                "signals": {s: clean(block[s].to_numpy(), DECIMALS.get(s, 2)) for s in ANALOG_SIGNALS},
                "loaded": clean(day_loaded.to_numpy(), 2),
                "score": clean(day_score.to_numpy(), 3),
            },
        )
        logged = rows.reindex(full).fillna(0).to_numpy()
        summary.append(
            {
                "date": name,
                "coverage": round(float(logged.sum() * 10 / 86400), 3),
                "loaded": round(float(np.nanmean(day_loaded.to_numpy())), 3),
                "oil_mean": round(float(np.nanmean(block["Oil_temperature"].to_numpy())), 1),
                "score_max": None if day_score.isna().all() else round(float(np.nanmax(day_score.to_numpy())), 3),
            }
        )
    return summary


def export_alarm_windows(df: pd.DataFrame, scores: pd.DataFrame, score: pd.Series, alarms: list[dict],
                         threshold: float) -> None:
    out_dir = REPLAY_DIR / "alarms"
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("*.json"):
        stale.unlink()
    err_cols = [f"err_{s}" for s in ANALOG_SIGNALS]
    for alarm in alarms:
        fire = pd.Timestamp(alarm["fire"])
        lo, hi = fire - ALARM_BEFORE, fire + ALARM_AFTER
        win = df.loc[lo:hi]
        win_err = scores.loc[lo:hi, err_cols].rolling("2min").mean().reindex(win.index)
        win_score = score.reindex(win.index)
        write_json(
            out_dir / f"{alarm['id']}.json",
            {
                "id": alarm["id"],
                "fire": epoch(fire),
                "onset": epoch(pd.Timestamp(alarm["onset"])),
                "end": epoch(pd.Timestamp(alarm["end"])),
                "threshold": round(threshold, 4),
                "t": [epoch(t) for t in win.index],
                "signals": {s: clean(win[s].to_numpy(), DECIMALS.get(s, 2)) for s in ANALOG_SIGNALS},
                "score": clean(win_score.to_numpy(), 3),
                "errors": {s: clean(win_err[f"err_{s}"].to_numpy(), 3) for s in ANALOG_SIGNALS},
            },
        )


def main() -> int:
    df = load()
    scores = pd.read_parquet(SCORES_PATH)
    score = faultline_score(scores)
    bench = json.loads(BENCH_JSON.read_text())
    methods = {m["key"]: m for m in bench["methods"]}
    fl = methods["faultline"]
    threshold = fl["params"]["threshold"]

    day_summary = export_days(df, score)
    export_alarm_windows(df, scores, score, fl["alarms"], threshold)

    def slim(alarm: dict) -> dict:
        keep = {
            "id": alarm["id"],
            "fire": epoch(pd.Timestamp(alarm["fire"])),
            "end": epoch(pd.Timestamp(alarm["end"])),
            "attribution": alarm["attribution"],
        }
        if "rules" in alarm:
            keep["rules"] = alarm["rules"]
        return keep

    manifest = {
        "generated_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "time_note": "timestamps are the dataset's wall-clock times encoded as UTC unix seconds",
        "step_s": STEP_S,
        "start": epoch(df.index[0]),
        "end": epoch(df.index[-1]),
        "signals": [{"key": s, "label": LABELS[s], "unit": UNITS[s]} for s in ANALOG_SIGNALS],
        "detector": {"threshold": round(threshold, 4), "duration_s": fl["params"]["duration_s"]},
        "failures": [
            {
                "id": f.id,
                "start": epoch(f.start),
                "end": epoch(f.end),
                "maintenance": epoch(f.maintenance) if f.maintenance is not None else None,
            }
            for f in load_failures()
        ],
        "alarms": {key: [slim(a) for a in m["alarms"]] for key, m in methods.items()},
        "methods": [{"key": m["key"], "label": m["label"]} for m in bench["methods"]],
        "days": day_summary,
    }
    write_json(REPLAY_DIR / "manifest.json", manifest)

    size = sum(p.stat().st_size for p in REPLAY_DIR.rglob("*.json"))
    print(f"wrote {len(day_summary)} days and {len(fl['alarms'])} alarm windows to "
          f"{REPLAY_DIR.relative_to(REPO_ROOT)}/ ({size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
