"""The four air-leak failures reported by the operator for MetroPT-3.

`data/failures.csv` is transcribed from the failure table in the dataset's own
description (UCI dataset 791, "Data Description_Metro.pdf" inside the zip). See
data/README.md for provenance and for why F2 carries no maintenance time.
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from faultline.config import FAILURES_CSV

# First reported failure. Everything strictly before this instant is "pre-failure"
# data: the only data that training and threshold tuning may read.
FIRST_FAILURE_START = pd.Timestamp("2020-04-18 00:00:00")


@dataclass(frozen=True)
class Failure:
    id: str
    start: pd.Timestamp
    end: pd.Timestamp
    failure: str
    severity: str
    maintenance: pd.Timestamp | None
    source_report_text: str


def load_failures(path=FAILURES_CSV) -> list[Failure]:
    df = pd.read_csv(path, parse_dates=["start", "end", "maintenance"], keep_default_na=True)
    failures = [
        Failure(
            id=row.id,
            start=row.start,
            end=row.end,
            failure=row.failure,
            severity=row.severity,
            maintenance=None if pd.isna(row.maintenance) else row.maintenance,
            source_report_text="" if pd.isna(row.source_report_text) else row.source_report_text,
        )
        for row in df.itertuples()
    ]
    if failures[0].start != FIRST_FAILURE_START:
        raise RuntimeError("FIRST_FAILURE_START is out of sync with data/failures.csv")
    return failures
