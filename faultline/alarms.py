"""Alarm logic shared by the detector and the static-threshold baseline.

An alarm fires when a score stays above a threshold for a minimum duration. The
alarm then stays active until that condition has been absent for `CLEAR_S`, so
one event produces one alarm rather than a burst of them.

Both parameters (threshold, duration) are tuned on pre-failure data only, by the
same procedure for every method: see `tune`.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from faultline.failures import GAP_S, assert_pre_failure

# An active alarm clears once its condition has been absent for this much logged time.
CLEAR_S = 3600

# Motor current above this means the compressor is working under load (the
# dataset description gives ~4 A offloaded and ~7 A under load; the observed
# histogram has a clean gap between 4 A and 5.5 A).
LOADED_CURRENT_A = 4.8

# Tuning grid, identical for every method.
QUANTILES = (
    0.50, 0.60, 0.70, 0.80, 0.85, 0.90, 0.925, 0.95, 0.96, 0.97, 0.98, 0.985,
    0.99, 0.9925, 0.995, 0.9975, 0.999, 0.9995, 0.9999,
)  # fmt: skip
DURATIONS_S = (60, 120, 300, 600, 900, 1200, 1800)

# A loaded run this long is treated as a proxy anomaly in pre-failure data. Normal
# loaded runs last about 2 minutes (99th percentile 6.4 min before the first failure).
SUSTAINED_LOAD_MIN_S = 20 * 60
SUSTAINED_LOAD_MERGE_S = 60 * 60

# Tuning objective: detect the pre-failure sustained-load episodes as early as
# possible, with at most this many alarms anywhere else in the pre-failure data.
MAX_OTHER_ALARMS = 2
DELAY_CAP_S = 2 * 3600
PROXY_GRACE_S = 30 * 60


@dataclass(frozen=True)
class Episode:
    onset: int  # start of the above-threshold run that fired, unix seconds
    fire: int  # when the minimum duration was met: the alarm time
    end: int  # last moment the alarm condition held


def to_seconds(index: pd.DatetimeIndex | np.ndarray) -> np.ndarray:
    return np.asarray(index).astype("datetime64[s]").astype(np.int64)


def _runs(ts: np.ndarray, flag: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Run-length encode `flag`, also breaking runs at gaps in the record."""
    n = len(ts)
    brk = np.empty(n, dtype=bool)
    brk[0] = True
    brk[1:] = (flag[1:] != flag[:-1]) | (np.diff(ts) > GAP_S)
    starts = np.flatnonzero(brk)
    ends = np.append(starts[1:] - 1, n - 1)
    return starts, ends, flag[starts]


def find_episodes(
    ts: np.ndarray, exceed: np.ndarray, duration_s: int, clear_s: int = CLEAR_S
) -> list[Episode]:
    """Alarm episodes for a boolean exceedance series sampled at unix seconds `ts`.

    The alarm condition holds while the score has been above threshold for at
    least `duration_s` without a break. A data gap breaks the run, because nothing
    is known about the score during the gap. An alarm fires when the condition
    first holds and stays active until the condition has been absent for
    `clear_s` of logged time; brief excursions that never meet the duration
    neither raise an alarm nor keep one alive.
    """
    if len(ts) == 0:
        return []
    starts, ends, values = _runs(ts, np.asarray(exceed, dtype=bool))
    steps = np.diff(ts, prepend=ts[0])
    logged = np.cumsum(np.where(steps <= GAP_S, steps, 0))  # logged seconds up to each row

    episodes: list[Episode] = []
    last_end: int | None = None  # row where the condition last held
    for s, e, above in zip(starts, ends, values):
        if not above or ts[e] - ts[s] < duration_s:
            continue
        if last_end is not None and logged[s] - logged[last_end] < clear_s:
            episodes[-1] = Episode(episodes[-1].onset, episodes[-1].fire, int(ts[e]))
        else:
            fire_idx = s + int(np.searchsorted(ts[s : e + 1], ts[s] + duration_s, side="left"))
            episodes.append(Episode(onset=int(ts[s]), fire=int(ts[fire_idx]), end=int(ts[e])))
        last_end = e
    return episodes


def sustained_load_episodes(index: pd.DatetimeIndex, motor_current: np.ndarray) -> list[tuple[int, int]]:
    """Stretches where the compressor ran under load far longer than a normal cycle."""
    ts = to_seconds(index)
    starts, ends, loaded = _runs(ts, np.asarray(motor_current) > LOADED_CURRENT_A)
    long_runs = [
        (int(ts[s]), int(ts[e]))
        for s, e, on in zip(starts, ends, loaded)
        if on and ts[e] - ts[s] >= SUSTAINED_LOAD_MIN_S
    ]
    merged: list[tuple[int, int]] = []
    for start, end in long_runs:
        if merged and start - merged[-1][1] < SUSTAINED_LOAD_MERGE_S:
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    return merged


@dataclass(frozen=True)
class TuneResult:
    quantile: float
    threshold: float
    duration_s: int
    mean_delay_s: float
    proxies_detected: int
    proxies_total: int
    other_alarms: int
    feasible: bool
    grid: list[dict]


def score_against_proxies(
    episodes: list[Episode], proxies: list[tuple[int, int]]
) -> tuple[float, int, int]:
    """Mean detection delay over the proxies (capped), detections, and other alarms."""
    fires = np.array([ep.fire for ep in episodes], dtype=np.int64)
    claimed = np.zeros(len(fires), dtype=bool)
    delays = []
    detected = 0
    for start, end in proxies:
        hit = (fires >= start) & (fires <= end + PROXY_GRACE_S)
        claimed |= hit
        if hit.any():
            delay = int(fires[hit].min()) - start
            detected += delay < DELAY_CAP_S
            delays.append(min(delay, DELAY_CAP_S))
        else:
            delays.append(DELAY_CAP_S)
    mean_delay = float(np.mean(delays)) if delays else float(DELAY_CAP_S)
    return mean_delay, detected, int((~claimed).sum())


def tune(
    index: pd.DatetimeIndex,
    score: np.ndarray,
    proxies: list[tuple[int, int]],
    *,
    quantiles: tuple[float, ...] = QUANTILES,
    durations_s: tuple[int, ...] = DURATIONS_S,
) -> TuneResult:
    """Pick (threshold, duration) on pre-failure data only.

    Thresholds are quantiles of the pre-failure score. Among the settings that
    raise at most MAX_OTHER_ALARMS alarms outside the pre-failure sustained-load
    episodes, choose the one that detects those episodes with the lowest mean
    delay. Ties go to fewer other alarms, then the lower threshold, then the
    shorter duration.
    """
    assert_pre_failure(index, "tune")
    ts = to_seconds(index)
    score = np.asarray(score, dtype=np.float64)
    finite = np.isfinite(score)
    thresholds = np.quantile(score[finite], quantiles)

    grid: list[dict] = []
    for q, thr in zip(quantiles, thresholds):
        exceed = finite & (score > thr)
        for d in durations_s:
            eps = find_episodes(ts, exceed, d)
            mean_delay, detected, other = score_against_proxies(eps, proxies)
            grid.append(
                {
                    "quantile": q,
                    "threshold": float(thr),
                    "duration_s": d,
                    "alarms": len(eps),
                    "other_alarms": other,
                    "proxies_detected": detected,
                    "mean_delay_s": round(mean_delay, 1),
                    "feasible": other <= MAX_OTHER_ALARMS,
                }
            )

    feasible = [g for g in grid if g["feasible"]]
    pool = feasible or grid
    best = min(pool, key=lambda g: (g["mean_delay_s"], g["other_alarms"], g["quantile"], g["duration_s"]))
    return TuneResult(
        quantile=best["quantile"],
        threshold=best["threshold"],
        duration_s=best["duration_s"],
        mean_delay_s=best["mean_delay_s"],
        proxies_detected=best["proxies_detected"],
        proxies_total=len(proxies),
        other_alarms=best["other_alarms"],
        feasible=bool(feasible),
        grid=grid,
    )
