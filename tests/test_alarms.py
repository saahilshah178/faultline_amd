"""Alarm logic, tuning, and the rule that fitting never sees failure data."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from faultline import alarms as A
from faultline import baseline as B
from faultline.detector import (
    DetectorConfig,
    assert_pre_failure,
    fit_scaler,
    segment_ids,
    valid_window_ends,
)
from faultline.failures import FIRST_FAILURE_START

T0 = pd.Timestamp("2020-02-01")


def series(minutes_above: list[tuple[int, int]], total_min: int = 600):
    """10-second series; `minutes_above` are [start, end) minute spans above threshold."""
    index = pd.date_range(T0, periods=total_min * 6, freq="10s")
    exceed = np.zeros(len(index), dtype=bool)
    for a, b in minutes_above:
        exceed[a * 6 : b * 6] = True
    return index, exceed


def minute(ts: int) -> float:
    return (ts - A.to_seconds(pd.DatetimeIndex([T0]))[0]) / 60


def test_alarm_fires_only_after_minimum_duration():
    index, exceed = series([(10, 14), (100, 130)])
    eps = A.find_episodes(A.to_seconds(index), exceed, duration_s=600)
    assert len(eps) == 1
    assert minute(eps[0].onset) == 100
    assert minute(eps[0].fire) == 110


def test_alarm_stays_active_until_cleared():
    # Two excursions 20 minutes apart are one alarm; one 3 hours later is a second.
    index, exceed = series([(100, 130), (150, 170), (350, 380)])
    eps = A.find_episodes(A.to_seconds(index), exceed, duration_s=600, clear_s=3600)
    assert [minute(e.fire) for e in eps] == [110, 360]
    assert minute(eps[0].end) == pytest.approx(170, abs=0.2)


def test_brief_excursions_do_not_keep_an_alarm_alive():
    # After the alarm, a 2-minute blip every 20 minutes (a normal compressor cycle
    # crossing a level threshold) must not stop it from clearing and firing again.
    blips = [(m, m + 2) for m in range(150, 560, 20)]
    index, exceed = series([(100, 130), *blips, (560, 590)])
    eps = A.find_episodes(A.to_seconds(index), exceed, duration_s=600, clear_s=3600)
    assert [minute(e.fire) for e in eps] == [110, 570]
    assert minute(eps[0].end) == pytest.approx(130, abs=0.2)


def test_alarm_does_not_clear_across_a_data_gap():
    # The unit stops logging for 10 hours mid-event and resumes still in alarm:
    # that is one alarm, because no logged time passed with the condition absent.
    first = pd.date_range(T0, periods=40 * 6, freq="10s")
    second = pd.date_range(first[-1] + pd.Timedelta(hours=10), periods=40 * 6, freq="10s")
    index = first.append(second)
    eps = A.find_episodes(A.to_seconds(index), np.ones(len(index), dtype=bool), duration_s=600)
    assert len(eps) == 1
    assert eps[0].end == A.to_seconds(index)[-1]


def test_gap_resets_the_duration_count():
    first = pd.date_range(T0, periods=30, freq="10s")  # 5 min above
    second = pd.date_range(first[-1] + pd.Timedelta(hours=3), periods=30, freq="10s")
    index = first.append(second)
    exceed = np.ones(len(index), dtype=bool)
    assert A.find_episodes(A.to_seconds(index), exceed, duration_s=480) == []
    assert len(A.find_episodes(A.to_seconds(index), exceed, duration_s=240)) == 1


def test_sustained_load_episodes_merge_and_filter():
    index = pd.date_range(T0, periods=600 * 6, freq="10s")
    current = np.full(len(index), 0.04)
    for a, b in [(10, 12), (100, 125), (140, 165), (400, 430)]:
        current[a * 6 : b * 6] = 5.8
    spans = A.sustained_load_episodes(index, current)
    assert len(spans) == 2  # the 2-minute run is normal; the two close runs merge
    assert minute(spans[0][0]) == 100 and minute(spans[1][0]) == 400


def test_tune_prefers_early_detection_within_the_alarm_budget():
    index = pd.date_range(T0, periods=3000 * 6, freq="10s")
    rng = np.random.default_rng(0)
    score = rng.normal(1.0, 0.05, len(index))
    proxies = []
    for start in (500, 1500, 2500):
        score[start * 6 : (start + 60) * 6] += 3.0
        s = A.to_seconds(index[[start * 6, (start + 60) * 6 - 1]])
        proxies.append((int(s[0]), int(s[1])))
    result = A.tune(index, score, proxies)
    assert result.feasible
    assert result.proxies_detected == 3
    assert result.other_alarms <= A.MAX_OTHER_ALARMS
    assert result.duration_s == min(A.DURATIONS_S)  # clean separation: shortest delay wins


def test_tuning_and_fitting_refuse_failure_data():
    index = pd.date_range(FIRST_FAILURE_START - pd.Timedelta(hours=1), periods=720, freq="10s")
    with pytest.raises(ValueError, match="first reported failure"):
        assert_pre_failure(index, "test")
    with pytest.raises(ValueError, match="first reported failure"):
        A.tune(index, np.zeros(len(index)), [])
    frame = pd.DataFrame(
        {c: np.zeros(len(index), dtype="float32") for c in
         ["TP2", "TP3", "H1", "DV_pressure", "Reservoirs", "Oil_temperature", "Motor_current"]},
        index=index,
    )
    with pytest.raises(ValueError, match="first reported failure"):
        fit_scaler(frame)
    with pytest.raises(ValueError, match="first reported failure"):
        B.tune_rules(frame, [])
    with pytest.raises(ValueError, match="first reported failure"):
        B.envelope_rules(frame)
    # The last pre-failure instant is allowed.
    assert_pre_failure(index[index < FIRST_FAILURE_START], "test")


def test_windows_never_span_a_gap():
    first = pd.date_range(T0, periods=300, freq="10s")
    second = pd.date_range(first[-1] + pd.Timedelta(hours=1), periods=250, freq="10s")
    index = first.append(second)
    window = DetectorConfig().window
    seg = segment_ids(index)
    ends = valid_window_ends(seg, window)
    assert len(ends) == (300 - window + 1) + (250 - window + 1)
    assert (seg[ends] == seg[ends - window + 1]).all()


def test_pressure_drop_rate_ignores_gaps():
    first = pd.date_range(T0, periods=20, freq="10s")
    second = pd.date_range(first[-1] + pd.Timedelta(hours=1), periods=20, freq="10s")
    index = first.append(second)
    pressure = np.concatenate([np.linspace(10, 9.05, 20), np.linspace(5, 5, 20)])
    rate = B.pressure_drop_rate(index, pressure)
    assert rate[10] == pytest.approx(0.3, abs=1e-6)  # 0.05 bar per 10 s
    assert np.isnan(rate[20:26]).all()  # a minute back is across the gap
    assert rate[30] == pytest.approx(0.0)


def test_merge_episodes_joins_overlapping_rules():
    a = [A.Episode(onset=0, fire=100, end=1000)]
    b = [A.Episode(onset=50, fire=400, end=2000), A.Episode(onset=5000, fire=5100, end=6000)]
    merged = B.merge_episodes({"x": a, "y": b})
    assert len(merged) == 2
    assert merged[0][0] == A.Episode(onset=0, fire=100, end=2000)
    assert merged[0][1] == ["x", "y"]
