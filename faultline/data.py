"""MetroPT-3: download, parse and store as parquet.

Source: UCI Machine Learning Repository, dataset 791 (CC BY 4.0).
https://archive.ics.uci.edu/dataset/791/metropt+3+dataset

    uv run python -m faultline.data            # download if needed, parse, summarise
    uv run python -m faultline.data --summary  # print the summary of an existing parquet
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

from faultline.config import DATA_DIR, PARQUET_PATH, RAW_DIR, RESULTS_DIR

UCI_ZIP_URL = "https://archive.ics.uci.edu/static/public/791/metropt+3+dataset.zip"
UCI_PAGE_URL = "https://archive.ics.uci.edu/dataset/791/metropt+3+dataset"

# What the UCI page states, used as the check in `summarise`.
UCI_EXPECTED_ROWS = 1_516_948
UCI_EXPECTED_FEATURES = 15

# Signals as named in the CSV header (including the dataset's own spelling "DV_eletric").
ANALOG_SIGNALS = [
    "TP2",
    "TP3",
    "H1",
    "DV_pressure",
    "Reservoirs",
    "Oil_temperature",
    "Motor_current",
]
DIGITAL_SIGNALS = [
    "COMP",
    "DV_eletric",
    "Towers",
    "MPG",
    "LPS",
    "Pressure_switch",
    "Oil_level",
    "Caudal_impulses",
]
ALL_SIGNALS = ANALOG_SIGNALS + DIGITAL_SIGNALS

# Nominal logging interval. Confirmed from the timestamps by `sampling_report`,
# which is the check that would fail loudly if this were wrong.
NOMINAL_INTERVAL_S = 10


def download(dest_dir: Path = RAW_DIR) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    zip_path = dest_dir / "metropt3.zip"
    if not zip_path.exists():
        print(f"downloading {UCI_ZIP_URL}")
        urllib.request.urlretrieve(UCI_ZIP_URL, zip_path)
    return zip_path


def extract_csv(zip_path: Path) -> Path:
    """Extract the single CSV from the UCI zip, refusing anything path-like."""
    with zipfile.ZipFile(zip_path) as zf:
        members = [m for m in zf.infolist() if m.filename.lower().endswith(".csv")]
        if len(members) != 1:
            raise RuntimeError(f"expected one CSV in {zip_path}, found {[m.filename for m in members]}")
        member = members[0]
        out = zip_path.parent / "metropt3.csv"
        if not out.exists() or out.stat().st_size != member.file_size:
            with zf.open(member) as src, open(out, "wb") as dst:
                while chunk := src.read(1 << 20):
                    dst.write(chunk)
    return out


def parse_csv(csv_path: Path) -> pd.DataFrame:
    """Read the raw CSV into a frame indexed by timestamp, sorted, float32/int8 typed."""
    df = pd.read_csv(csv_path)
    # The file carries an unnamed leading row-number column.
    unnamed = [c for c in df.columns if c.startswith("Unnamed")]
    df = df.drop(columns=unnamed)
    missing = [c for c in ["timestamp", *ALL_SIGNALS] if c not in df.columns]
    if missing:
        raise RuntimeError(f"CSV is missing expected columns: {missing}; has {list(df.columns)}")

    df["timestamp"] = pd.to_datetime(df["timestamp"], format="%Y-%m-%d %H:%M:%S")
    df = df.sort_values("timestamp", kind="stable")
    if df["timestamp"].duplicated().any():
        raise RuntimeError("duplicate timestamps in raw data")
    df = df.set_index("timestamp")

    for col in ANALOG_SIGNALS:
        df[col] = df[col].astype("float32")
    for col in DIGITAL_SIGNALS:
        values = df[col]
        if not np.isin(values.unique(), [0.0, 1.0]).all():
            raise RuntimeError(f"digital signal {col} has values other than 0/1")
        df[col] = values.astype("int8")
    return df[ALL_SIGNALS]


def sampling_report(index: pd.DatetimeIndex) -> dict:
    """Describe the actual sampling interval and the gaps in the record."""
    deltas = index.to_series().diff().dropna().dt.total_seconds()
    counts = deltas.value_counts()
    modal = float(counts.index[0])
    gaps = deltas[deltas > 60]
    span_s = (index[-1] - index[0]).total_seconds()
    return {
        "modal_interval_s": modal,
        "median_interval_s": float(deltas.median()),
        "share_at_modal": float(counts.iloc[0] / len(deltas)),
        "share_within_9_to_11_s": float(((deltas >= 9) & (deltas <= 11)).mean()),
        "interval_counts_top": {str(k): int(v) for k, v in counts.head(8).items()},
        "min_interval_s": float(deltas.min()),
        "max_interval_s": float(deltas.max()),
        "gaps_over_60s": len(gaps),
        "gaps_over_1h": int((deltas > 3600).sum()),
        "longest_gaps": [
            {
                "after": str(index[index.get_loc(ts) - 1]),
                "resumes": str(ts),
                "hours": round(sec / 3600, 2),
            }
            for ts, sec in gaps.nlargest(8).items()
        ],
        "coverage_of_span_at_modal": float(len(index) * modal / span_s),
    }


def summarise(df: pd.DataFrame) -> dict:
    report = {
        "source": UCI_PAGE_URL,
        "rows": len(df),
        "rows_match_uci": bool(len(df) == UCI_EXPECTED_ROWS),
        "features": int(df.shape[1]),
        "features_match_uci": bool(df.shape[1] == UCI_EXPECTED_FEATURES),
        "start": str(df.index[0]),
        "end": str(df.index[-1]),
        "analog_signals": ANALOG_SIGNALS,
        "digital_signals": DIGITAL_SIGNALS,
        "missing_values": int(df.isna().sum().sum()),
        "sampling": sampling_report(df.index),
        "signal_stats": {
            col: {
                "min": float(df[col].min()),
                "p01": float(df[col].quantile(0.01)),
                "median": float(df[col].median()),
                "p99": float(df[col].quantile(0.99)),
                "max": float(df[col].max()),
            }
            for col in ANALOG_SIGNALS
        },
        "digital_share_on": {col: float(df[col].mean()) for col in DIGITAL_SIGNALS},
    }
    return report


def load() -> pd.DataFrame:
    if not PARQUET_PATH.exists():
        raise FileNotFoundError(
            f"{PARQUET_PATH} not found. Run: uv run python -m faultline.data"
        )
    return pd.read_parquet(PARQUET_PATH)


def build() -> pd.DataFrame:
    DATA_DIR.mkdir(exist_ok=True)
    csv_path = extract_csv(download())
    df = parse_csv(csv_path)
    df.to_parquet(PARQUET_PATH, compression="zstd")
    return df


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary", action="store_true", help="only summarise the parquet")
    args = parser.parse_args(argv)

    df = load() if args.summary else build()
    report = summarise(df)

    out = RESULTS_DIR / "eda" / "dataset_summary.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")

    s = report["sampling"]
    print(f"rows        {report['rows']:,}  (UCI states {UCI_EXPECTED_ROWS:,}: "
          f"{'match' if report['rows_match_uci'] else 'MISMATCH'})")
    print(f"features    {report['features']}  (UCI states {UCI_EXPECTED_FEATURES}: "
          f"{'match' if report['features_match_uci'] else 'MISMATCH'})")
    print(f"time range  {report['start']} -> {report['end']}")
    print(f"analog      {', '.join(ANALOG_SIGNALS)}")
    print(f"digital     {', '.join(DIGITAL_SIGNALS)}")
    print(f"missing     {report['missing_values']}")
    print(f"interval    modal {s['modal_interval_s']:.0f}s, median {s['median_interval_s']:.0f}s, "
          f"{s['share_within_9_to_11_s']:.2%} of steps within 9-11s")
    print(f"gaps        {s['gaps_over_60s']} over 60s, {s['gaps_over_1h']} over 1h, "
          f"longest {s['longest_gaps'][0]['hours'] if s['longest_gaps'] else 0}h")
    print(f"wrote       {PARQUET_PATH.relative_to(PARQUET_PATH.parent.parent)} and "
          f"{out.relative_to(RESULTS_DIR.parent)}")
    ok = report["rows_match_uci"] and report["features_match_uci"]
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
