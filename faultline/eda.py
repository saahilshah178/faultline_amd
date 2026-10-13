"""Exploratory plots: one figure per reported failure window, plus a timeline overview.

    uv run python -m faultline.eda
"""

from __future__ import annotations

import matplotlib

matplotlib.use("Agg")

import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import pandas as pd

from faultline.config import RESULTS_DIR
from faultline.data import ANALOG_SIGNALS, load
from faultline.failures import Failure, load_failures

EDA_DIR = RESULTS_DIR / "eda"

UNITS = {
    "TP2": "bar",
    "TP3": "bar",
    "H1": "bar",
    "DV_pressure": "bar",
    "Reservoirs": "bar",
    "Oil_temperature": "°C",
    "Motor_current": "A",
}

# Motor current above this means the compressor is working under load. The dataset
# description gives ~4 A offloaded and ~7 A under load; the observed histogram has
# a clean gap between ~4 A and ~5.5 A.
LOADED_CURRENT_A = 4.8

INK = "#1f2933"
MUTED = "#7b8794"
SERIES = "#2563eb"
FAIL = "#dc2626"


def loaded_share(df: pd.DataFrame, rule: str) -> pd.Series:
    """Share of logged samples in each bin with the compressor under load."""
    return (df["Motor_current"] > LOADED_CURRENT_A).astype("float32").resample(rule).mean()


def plot_failure(df: pd.DataFrame, failure: Failure, before_h: int = 36, after_h: int = 12) -> None:
    t0 = failure.start - pd.Timedelta(hours=before_h)
    t1 = max(failure.end, failure.maintenance or failure.end) + pd.Timedelta(hours=after_h)
    view = df.loc[t0:t1]
    # One-minute means keep the cycle structure visible without 30k points per panel.
    minute = view[ANALOG_SIGNALS].resample("1min").mean()
    duty = loaded_share(view, "30min")

    fig, axes = plt.subplots(len(ANALOG_SIGNALS) + 1, 1, figsize=(13, 13), sharex=True)
    for ax, sig in zip(axes, ANALOG_SIGNALS):
        ax.plot(minute.index, minute[sig], color=SERIES, lw=0.7)
        ax.set_ylabel(f"{sig}\n({UNITS[sig]})", fontsize=8, color=INK)
    axes[-1].fill_between(duty.index, 0, duty.values * 100, step="mid", color=SERIES, alpha=0.6, lw=0)
    axes[-1].set_ylabel("under load\n(% of 30 min)", fontsize=8, color=INK)
    axes[-1].set_ylim(0, 100)

    for ax in axes:
        ax.axvspan(failure.start, failure.end, color=FAIL, alpha=0.10, lw=0)
        if failure.maintenance is not None:
            ax.axvline(failure.maintenance, color=INK, ls="--", lw=0.9)
        ax.grid(True, color="#e4e7eb", lw=0.5)
        ax.tick_params(labelsize=8, colors=MUTED)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)

    axes[-1].xaxis.set_major_formatter(mdates.DateFormatter("%b %d\n%H:%M"))
    title = (
        f"{failure.id}: {failure.failure.lower()} reported "
        f"{failure.start:%b %d %H:%M} to {failure.end:%b %d %H:%M} 2020 (shaded)"
    )
    if failure.maintenance is not None:
        title += f"; maintenance {failure.maintenance:%b %d %H:%M} (dashed)"
    fig.suptitle(title, fontsize=11, color=INK, x=0.01, ha="left")
    fig.text(
        0.01,
        0.005,
        "MetroPT-3 (UCI 791, CC BY 4.0). One-minute means; blank stretches are gaps in the record.",
        fontsize=7,
        color=MUTED,
    )
    fig.tight_layout(rect=(0, 0.012, 1, 0.975))
    fig.savefig(EDA_DIR / f"failure_{failure.id}.png", dpi=130)
    plt.close(fig)


def plot_overview(df: pd.DataFrame, failures: list[Failure]) -> None:
    daily_duty = loaded_share(df, "1D") * 100
    daily_oil = df["Oil_temperature"].resample("1D").mean()
    daily_rows = df["TP2"].resample("1D").count()
    coverage = daily_rows * 10 / 86400 * 100

    fig, axes = plt.subplots(3, 1, figsize=(13, 7), sharex=True)
    axes[0].bar(daily_duty.index, daily_duty.values, width=0.9, color=SERIES)
    axes[0].set_ylabel("under load\n(% of logged time)", fontsize=8, color=INK)
    axes[1].plot(daily_oil.index, daily_oil.values, color=SERIES, lw=1.2)
    axes[1].set_ylabel("oil temperature\ndaily mean (°C)", fontsize=8, color=INK)
    axes[2].bar(coverage.index, coverage.values.clip(max=100), width=0.9, color=MUTED)
    axes[2].set_ylabel("day covered\nby data (%)", fontsize=8, color=INK)
    for ax in axes:
        for f in failures:
            ax.axvspan(f.start, f.end + pd.Timedelta(hours=12), color=FAIL, alpha=0.18, lw=0)
        ax.grid(True, color="#e4e7eb", lw=0.5)
        ax.tick_params(labelsize=8, colors=MUTED)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
    for f in failures:
        axes[0].annotate(f.id, (f.start, 97), fontsize=8, color=FAIL, ha="center", va="top")
    axes[0].set_ylim(0, 100)
    axes[-1].xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
    fig.suptitle(
        "MetroPT-3 timeline, Feb-Aug 2020: compressor load, oil temperature and data coverage "
        "(reported air leaks shaded)",
        fontsize=11,
        color=INK,
        x=0.01,
        ha="left",
    )
    fig.tight_layout(rect=(0, 0, 1, 0.96))
    fig.savefig(EDA_DIR / "overview.png", dpi=130)
    plt.close(fig)


def main() -> int:
    EDA_DIR.mkdir(parents=True, exist_ok=True)
    df = load()
    failures = load_failures()
    for failure in failures:
        plot_failure(df, failure)
        print(f"wrote results/eda/failure_{failure.id}.png")
    plot_overview(df, failures)
    print("wrote results/eda/overview.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
