# Benchmark

Generated 2026-10-13T08:42:01Z by `python -m faultline.evaluate` from `data/scores_metropt2.parquet` and `results/metropt2/train.json` (MetroPT-2). Do not edit by hand.

Detector trained on: **mps (local development run, not the MI300X)**, PyTorch 2.14.1. Training time 433 s for 5 cross-fitting folds plus the final model (80 s for the final model alone); 89,047 parameters.

## First alarm relative to the start of each reported failure window

| Failure | Reported window (2022) | Faultline (conv autoencoder) | Static thresholds, tuned like the detector | Static thresholds at the pre-failure envelope |
|---|---|---|---|---|
| F1 (air leak) | 06-04 10:19 to 06-04 14:22 | 51 min after | 39 min after | 32 min after |
| F2 (oil leak) | 07-11 10:10 to 07-14 10:22 | 48 min after | 41.8 h after | 55.4 h after |

## Detection and false alarms

| | Faultline (conv autoencoder) | Static thresholds, tuned like the detector | Static thresholds at the pre-failure envelope |
|---|---|---|---|
| Failures detected (of 2) | 2 | 2 | 2 |
| Detected before the window start | 0 | 0 | 0 |
| False alarms | 3 | 0 | 0 |
| False alarms per week | 0.44 | 0.00 | 0.00 |
| False alarms per week of logged data | 0.49 | 0.00 | 0.00 |
| False alarms during sustained compressor load | 0 | 0 | 0 |
| Alarms in the tuning period | 0 | 0 | 0 |

False alarms are counted from 2022-06-04 to 2022-07-28, outside the failure spans: 6.8 calendar weeks, 6.2 weeks of logged data. "During sustained compressor load" counts false alarms that fired while the compressor had been under load for more than 20 minutes without a break, the same behaviour as in the reported failures, on days with no failure report.

## Settings chosen on pre-failure data

- Faultline: score above 0.1524 (the 95.00% quantile of pre-failure scores) for 20 min.
- Static thresholds, tuned like the detector: oil temperature high above 65.4 °C for 30 min; motor current high above 3.71 A for 30 min; reservoir pressure falling fast above 0.054 bar/min for 30 min.
- Static thresholds at the pre-failure envelope: oil temperature high above 77.025 °C for 1 min; motor current high above 9.03 A for 1 min; reservoir pressure falling fast above 1.892 bar/min for 1 min.

## The tuned static rules, one at a time

| Rule | Failures detected | First alarm vs window start (F1 to F2) | False alarms | False alarms per week |
|---|---|---|---|---|
| Oil temperature high | 2 | 39 min after, 41.8 h after | 0 | 0.00 |
| Motor current high | 1 | 59 min after, missed | 0 | 0.00 |
| Reservoir pressure falling fast | 0 | missed, missed | 0 | 0.00 |

## Protocol

- Training and tuning read only data before 2022-06-04 10:19:24.300000, the start of the first reported failure. The code enforces this (`assert_pre_failure`).
- The pre-failure data contains no episode of sustained compressor load to tune against, so the same procedure reduces to its tie-break: each method gets the lowest threshold, then the shortest duration, that raises no alarm at all in the pre-failure period.
- A failure counts as detected if an alarm fires from 24 h before its window starts until the window ends (or the reported maintenance, if later). Alarms outside those spans, and outside the 24 h after them, are false alarms.
- The detector needs 32 minutes of unbroken data before it can score, so it is blind for that long after every gap in the record; it scored 97.6% of the rows.
- Two failures is a small sample. Treat every number here as a case study, not a rate.

## Sensitivity to the lead horizon

How the result changes if alarms further ahead of a failure are credited to it.

| Horizon | Faultline (conv autoencoder): detected / false alarms per week | Static thresholds, tuned like the detector: detected / false alarms per week | Static thresholds at the pre-failure envelope: detected / false alarms per week |
|---|---|---|---|
| 2 h | 2 / 0.43 | 2 / 0.00 | 2 / 0.00 |
| 6 h | 2 / 0.43 | 2 / 0.00 | 2 / 0.00 |
| 12 h | 2 / 0.43 | 2 / 0.00 | 2 / 0.00 |
| 24 h | 2 / 0.44 | 2 / 0.00 | 2 / 0.00 |
| 48 h | 2 / 0.45 | 2 / 0.00 | 2 / 0.00 |
| 72 h | 2 / 0.46 | 2 / 0.00 | 2 / 0.00 |
| 168 h | 2 / 0.50 | 2 / 0.00 | 2 / 0.00 |
