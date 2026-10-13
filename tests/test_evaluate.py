"""Scoring rules of the evaluation: attribution, lead time and false alarms."""

from __future__ import annotations

import numpy as np
import pandas as pd

from faultline import evaluate as E
from faultline.alarms import Episode
from faultline.failures import load_failures

FAILURES = load_failures()


def at(text: str) -> int:
    return E.secs(pd.Timestamp(text))


def test_alarm_attribution():
    zs = E.zones(FAILURES, 24)
    assert E.classify(at("2020-05-29 23:20"), zs) == "F2"  # 10 min before the window
    assert E.classify(at("2020-05-30 03:00"), zs) == "F2"  # inside the window
    assert E.classify(at("2020-05-28 20:00"), zs) == "false_alarm"  # beyond the 24 h horizon
    assert E.classify(at("2020-06-08 10:00"), zs) == "F3"  # after the window, before maintenance
    assert E.classify(at("2020-06-09 10:00"), zs) == "buffer:F3"  # within 24 h after maintenance
    assert E.classify(at("2020-06-20 10:00"), zs) == "false_alarm"
    assert E.classify(at("2020-03-12 10:00"), zs) == "tuning_period"


def test_lead_time_sign_and_maintenance():
    zs = E.zones(FAILURES, 24)
    fires = np.array([at("2020-06-05 09:30"), at("2020-06-06 12:00"), at("2020-07-15 15:00")])
    rows = {r["id"]: r for r in E.failure_rows(fires, zs)}
    assert rows["F3"]["detected"] and rows["F3"]["lead_before_start_h"] == 0.5
    assert rows["F3"]["lead_before_maintenance_h"] == 78.5
    assert rows["F3"]["alarms_in_span"] == 2
    assert rows["F4"]["lead_before_start_h"] == -0.5  # half an hour after the window opened
    assert rows["F4"]["lead_before_maintenance_h"] == 9.0
    assert not rows["F1"]["detected"] and rows["F1"]["lead_before_start_h"] is None
    assert rows["F2"]["lead_before_maintenance_h"] is None


def test_false_alarm_rate_uses_only_time_outside_failure_spans():
    index = pd.date_range("2020-02-01", "2020-09-01", freq="10s")
    ts = E.A.to_seconds(index)
    zs = E.zones(FAILURES, 24)
    period = E.evaluation_period(ts, zs)
    total_weeks = (at("2020-09-01") - at("2020-04-18")) / E.WEEK_S
    assert period["calendar_weeks"] < total_weeks
    # No gaps in this synthetic record, so logged time equals calendar time.
    assert abs(period["calendar_weeks"] - period["observed_weeks"]) < 0.01

    episodes = [
        Episode(at("2020-05-01 10:00"), at("2020-05-01 10:10"), at("2020-05-01 12:00")),
        Episode(at("2020-06-05 09:50"), at("2020-06-05 10:00"), at("2020-06-07 15:00")),
    ]
    result = E.summarise(episodes, zs, period, np.empty((0, 2), dtype=np.int64))
    assert result["summary"]["false_alarms"] == 1
    assert result["summary"]["failures_detected"] == 1
    assert result["summary"]["false_alarms_per_week"] == round(1 / period["calendar_weeks"], 3)


def test_lead_formatting():
    assert E.fmt_lead(None) == "missed"
    assert E.fmt_lead(0.25) == "15 min before"
    assert E.fmt_lead(-0.5) == "30 min after"
    assert E.fmt_lead(5.0) == "5.0 h before"


def test_evaluation_and_reporting_do_not_need_pytorch():
    """Training happens on the droplet; the laptop side must run without torch installed."""
    import subprocess
    import sys

    code = (
        "import sys; sys.modules['torch'] = None\n"
        "import faultline.evaluate, faultline.evidence, faultline.export_replay\n"
        "import faultline.profile, faultline.report, faultline.explain, faultline.kb\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr[-600:]
