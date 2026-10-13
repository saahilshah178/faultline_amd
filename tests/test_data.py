"""Parsing tests. The synthetic ones always run; the `data` ones need the parquet."""

from __future__ import annotations

import pandas as pd
import pytest

from faultline import data
from faultline.config import PARQUET_PATH
from faultline.failures import FIRST_FAILURE_START, load_failures

HEADER = ",timestamp," + ",".join(data.ALL_SIGNALS)


def _row(i: int, ts: str, digital: float = 1.0) -> str:
    analog = ["0.5", "9.1", "9.0", "0.0", "9.1", "55.25", "0.04"]
    return f"{i},{ts}," + ",".join(analog + [str(digital)] * len(data.DIGITAL_SIGNALS))


def _csv(tmp_path, rows: list[str]):
    path = tmp_path / "sample.csv"
    path.write_text("\n".join([HEADER, *rows]) + "\n")
    return path


def test_parse_drops_row_number_column_and_types(tmp_path):
    path = _csv(tmp_path, [_row(0, "2020-02-01 00:00:00"), _row(10, "2020-02-01 00:00:10")])
    df = data.parse_csv(path)
    assert list(df.columns) == data.ALL_SIGNALS
    assert isinstance(df.index, pd.DatetimeIndex) and df.index.name == "timestamp"
    assert all(df[c].dtype == "float32" for c in data.ANALOG_SIGNALS)
    assert all(df[c].dtype == "int8" for c in data.DIGITAL_SIGNALS)
    assert df["Oil_temperature"].iloc[0] == pytest.approx(55.25)


def test_parse_sorts_by_timestamp(tmp_path):
    path = _csv(tmp_path, [_row(10, "2020-02-01 00:00:10"), _row(0, "2020-02-01 00:00:00")])
    df = data.parse_csv(path)
    assert df.index.is_monotonic_increasing
    assert df.index[0] == pd.Timestamp("2020-02-01 00:00:00")


def test_parse_rejects_duplicate_timestamps(tmp_path):
    path = _csv(tmp_path, [_row(0, "2020-02-01 00:00:00"), _row(10, "2020-02-01 00:00:00")])
    with pytest.raises(RuntimeError, match="duplicate"):
        data.parse_csv(path)


def test_parse_rejects_non_binary_digital(tmp_path):
    path = _csv(tmp_path, [_row(0, "2020-02-01 00:00:00", digital=0.5)])
    with pytest.raises(RuntimeError, match="other than 0/1"):
        data.parse_csv(path)


def test_parse_rejects_missing_column(tmp_path):
    path = tmp_path / "bad.csv"
    path.write_text(",timestamp,TP2\n0,2020-02-01 00:00:00,0.1\n")
    with pytest.raises(RuntimeError, match="missing expected columns"):
        data.parse_csv(path)


def test_sampling_report_finds_interval_and_gaps():
    first = pd.date_range("2020-02-01", periods=100, freq="10s")
    second = pd.date_range(first[-1] + pd.Timedelta(hours=2), periods=100, freq="10s")
    report = data.sampling_report(first.append(second))
    assert report["modal_interval_s"] == 10.0
    assert report["gaps_over_60s"] == 1
    assert report["gaps_over_1h"] == 1
    assert report["longest_gaps"][0]["hours"] == 2.0


def test_failures_csv_is_consistent():
    failures = load_failures()
    assert [f.id for f in failures] == ["F1", "F2", "F3", "F4"]
    assert failures[0].start == FIRST_FAILURE_START
    for f in failures:
        assert f.start < f.end
        if f.maintenance is not None:
            assert f.maintenance > f.end
    assert all(a.end < b.start for a, b in zip(failures, failures[1:]))
    # Only F3 and F4 have a usable maintenance time; F2's source text is kept verbatim.
    assert [f.maintenance is not None for f in failures] == [False, False, True, True]
    assert failures[1].source_report_text == "Maintenance on 30Apr at 12:00"
    assert failures[2].maintenance == pd.Timestamp("2020-06-08 16:00:00")
    assert failures[3].maintenance == pd.Timestamp("2020-07-16 00:00:00")


needs_data = pytest.mark.skipif(not PARQUET_PATH.exists(), reason="run `python -m faultline.data`")


@pytest.mark.data
@needs_data
def test_parquet_matches_uci():
    df = data.load()
    assert len(df) == data.UCI_EXPECTED_ROWS
    assert list(df.columns) == data.ALL_SIGNALS
    assert df.shape[1] == data.UCI_EXPECTED_FEATURES
    assert df.index[0] == pd.Timestamp("2020-02-01 00:00:00")
    assert df.index[-1] == pd.Timestamp("2020-09-01 03:59:50")
    assert df.index.is_monotonic_increasing and df.index.is_unique
    assert not df.isna().any().any()


@pytest.mark.data
@needs_data
def test_sampling_interval_is_ten_seconds():
    report = data.sampling_report(data.load().index)
    assert report["modal_interval_s"] == data.NOMINAL_INTERVAL_S
    assert report["share_within_9_to_11_s"] > 0.95


@pytest.mark.data
@needs_data
def test_failure_windows_fall_inside_the_record():
    df = data.load()
    for f in load_failures():
        assert df.index[0] < f.start and f.end < df.index[-1]
        assert len(df.loc[f.start : f.end]) > 1000
