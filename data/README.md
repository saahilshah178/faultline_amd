# Data

Nothing in this directory is committed except this file and `failures.csv`.
Rebuild the rest with:

    uv run python -m faultline.data

## MetroPT-3

- Source: UCI Machine Learning Repository, dataset 791, "MetroPT-3 Dataset".
  https://archive.ics.uci.edu/dataset/791/metropt+3+dataset
- License: CC BY 4.0.
- Download: https://archive.ics.uci.edu/static/public/791/metropt+3+dataset.zip
  (one CSV, `MetroPT3(AirCompressor).csv`, plus `Data Description_Metro.pdf`).
- Stored as `data/metropt3.parquet`, indexed by timestamp.

### Sampling interval

The sources disagree about the sampling rate. The UCI page says in one place
that the data "were logged at 1Hz" and in another that the 1,516,948 points were
"collected at 0.1Hz"; the description PDF inside the zip says 1Hz and gives the
number of instances as 15,169,480. The released CSV settles it: it has 1,516,948
rows and its timestamps are 10 seconds apart (88% of consecutive rows are
exactly 10 s apart, 97% within 9-11 s). The record also has gaps where the unit
was not logging (331 gaps longer than a minute, 160 longer than an hour, the
longest 48 hours), so the rows cover about 82% of the Feb 1 - Sep 1 2020 span.
These figures are computed by `faultline.data.sampling_report` and saved in
`results/eda/dataset_summary.json`.

Faultline therefore treats the data as a 10-second series with gaps, and never
builds a model window across a gap.

## failures.csv

The dataset is unlabeled. The operator's failure reports are given as a table in
`Data Description_Metro.pdf` (inside the UCI zip) and on the UCI page.
`failures.csv` transcribes that table:

| id | start | end | failure | maintenance |
|----|-------|-----|---------|-------------|
| F1 | 2020-04-18 00:00 | 2020-04-18 23:59 | Air leak | not reported |
| F2 | 2020-05-29 23:30 | 2020-05-30 06:00 | Air leak | see note |
| F3 | 2020-06-05 10:00 | 2020-06-07 14:30 | Air leak | 2020-06-08 16:00 |
| F4 | 2020-07-15 14:30 | 2020-07-15 19:00 | Air leak | 2020-07-16 00:00 |

Note on F2: the source table's report column reads "Maintenance on 30Apr at
12:00", a date a month before the failure it is attached to. It may be a typo
for 30 May, but we have no way to confirm that, so `maintenance` is left empty
for F2 and the original text is kept verbatim in `source_report_text`. Lead time
to maintenance is reported only for F3 and F4.

A note on the reported windows: in the data, each window begins within minutes
of the compressor going into continuous load (for example F2 is reported from
23:30 and the compressor stops cycling at 23:14). The windows mark when the
leak was already in full effect, not when it began to develop.

### Where the failure table comes from

The table above is published only with the dataset itself (the UCI page and the
PDF in the zip). The MetroPT paper usually cited for it, Veloso et al., "The
MetroPT dataset for predictive maintenance" (Scientific Data 9, 764, 2022;
arXiv:2207.05466), describes a later recording from 2022 with a different set
of failures and does not contain these 2020 dates or the maintenance times. We
cite the paper for the description of the air production unit and its sensors,
and the UCI record for the failure reports.

## MetroPT-2 (held-out second test)

- Source: Zenodo record 7766691, "MetroPT2: A Benchmark dataset for predictive
  maintenance" (Veloso, Gama, Ribeiro, Pereira), CC BY 4.0.
  https://doi.org/10.5281/zenodo.7766691
- A later recording from the same operator: 2022-04-28 to 2022-07-28, logged
  once a second, with the same fifteen signals as MetroPT-3 plus a flowmeter and
  GPS. `FAULTLINE_DATASET=metropt2 uv run python -m faultline.data` downloads
  `MetroPT2.csv` (1.2 GB) and keeps the first reading of every 10-second bin, so
  the series has the same form as MetroPT-3. Stored as `data/metropt2.parquet`.
- `failures_metropt2.csv` transcribes the failure table in the Zenodo record:

| id | start | end | failure |
|----|-------|-----|---------|
| F1 | 2022-06-04 10:19:24 | 2022-06-04 14:22:39 | Air leak |
| F2 | 2022-07-11 10:10:18 | 2022-07-14 10:22:08 | Oil leak |

  The record gives no severity and no maintenance times.
- Nothing about the detector, the baselines or the tuning procedure was chosen
  with this dataset. It is run through the same code after the fact, trained
  and tuned on its own data from before its first failure.

References:

- Davari, N., Veloso, B., Ribeiro, R., Gama, J. "MetroPT-3 Dataset." UCI Machine
  Learning Repository (2021). https://doi.org/10.24432/C5VW3R
- Veloso, B., Ribeiro, R.P., Gama, J., Pereira, P.M. "The MetroPT dataset for
  predictive maintenance." Scientific Data 9, 764 (2022). arXiv:2207.05466.
- Davari, N., Veloso, B., Ribeiro, R.P., Pereira, P.M., Gama, J. "Predictive
  maintenance based on anomaly detection using deep learning for air production
  unit in the railway industry." IEEE DSAA 2021.
