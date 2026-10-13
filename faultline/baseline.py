"""Static-threshold baseline: the alarms a plant would plausibly already run.

Three level alarms on raw signals:
  - oil temperature too high
  - motor current too high
  - reservoir pressure falling too fast

Two variants, both set from pre-failure data only:
  - "tuned": each alarm's threshold and on-delay chosen by exactly the procedure
    used for the detector (`faultline.alarms.tune`), so the comparison is like for like.
  - "envelope": each limit placed at the most extreme value seen before the first
    failure, with a one-minute on-delay. This is the conventional way to set a
    level alarm: just outside the range the plant has been observed to run in.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from faultline.alarms import Episode, find_episodes, to_seconds, tune
from faultline.failures import assert_pre_failure

RULES = {
    "oil_temperature": {"label": "Oil temperature high", "unit": "°C"},
    "motor_current": {"label": "Motor current high", "unit": "A"},
    "pressure_drop_rate": {"label": "Reservoir pressure falling fast", "unit": "bar/min"},
}

ENVELOPE_DELAY_S = 60


def pressure_drop_rate(index: pd.DatetimeIndex, reservoirs: np.ndarray) -> np.ndarray:
    """Fall in reservoir pressure over the last minute, in bar/min (positive = falling).

    NaN where the row a minute back is on the other side of a gap.
    """
    ts = to_seconds(index)
    lag = 6
    rate = np.full(len(ts), np.nan)
    dt = (ts[lag:] - ts[:-lag]).astype(np.float64)
    ok = (dt >= 50) & (dt <= 75)
    drop = (reservoirs[:-lag] - reservoirs[lag:]).astype(np.float64)
    rate[lag:] = np.where(ok, drop / (dt / 60.0), np.nan)
    return rate


def rule_signals(df: pd.DataFrame) -> dict[str, np.ndarray]:
    return {
        "oil_temperature": df["Oil_temperature"].to_numpy(dtype=np.float64),
        "motor_current": df["Motor_current"].to_numpy(dtype=np.float64),
        "pressure_drop_rate": pressure_drop_rate(df.index, df["Reservoirs"].to_numpy()),
    }


def merge_episodes(per_rule: dict[str, list[Episode]]) -> list[tuple[Episode, list[str]]]:
    """Combine the rules into one alarm stream: overlapping alarms are one alarm."""
    tagged = sorted(
        ((ep, rule) for rule, eps in per_rule.items() for ep in eps), key=lambda x: x[0].fire
    )
    merged: list[tuple[Episode, list[str]]] = []
    for ep, rule in tagged:
        if merged and ep.fire <= merged[-1][0].end:
            last, rules = merged[-1]
            merged[-1] = (
                Episode(onset=min(last.onset, ep.onset), fire=last.fire, end=max(last.end, ep.end)),
                rules if rule in rules else [*rules, rule],
            )
        else:
            merged.append((ep, [rule]))
    return merged


def tune_rules(pre: pd.DataFrame, proxies: list[tuple[int, int]]) -> dict[str, dict]:
    assert_pre_failure(pre.index, "tune_rules")
    params = {}
    for rule, signal in rule_signals(pre).items():
        result = tune(pre.index, signal, proxies)
        params[rule] = {
            "threshold": result.threshold,
            "quantile": result.quantile,
            "duration_s": result.duration_s,
            "tuning": {
                "feasible": result.feasible,
                "proxies_detected": result.proxies_detected,
                "proxies_total": result.proxies_total,
                "mean_delay_min": round(result.mean_delay_s / 60, 1),
                "other_alarms": result.other_alarms,
            },
        }
    return params


def envelope_rules(pre: pd.DataFrame) -> dict[str, dict]:
    assert_pre_failure(pre.index, "envelope_rules")
    return {
        rule: {"threshold": float(np.nanmax(signal)), "quantile": 1.0, "duration_s": ENVELOPE_DELAY_S}
        for rule, signal in rule_signals(pre).items()
    }


def run_rules(df: pd.DataFrame, params: dict[str, dict]) -> dict[str, list[Episode]]:
    ts = to_seconds(df.index)
    signals = rule_signals(df)
    out = {}
    for rule, p in params.items():
        signal = signals[rule]
        exceed = np.isfinite(signal) & (signal > p["threshold"])
        out[rule] = find_episodes(ts, exceed, p["duration_s"])
    return out
