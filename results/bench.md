# Benchmark

Generated 2026-10-13T07:53:50Z by `python -m faultline.evaluate` from `data/scores.parquet` and `results/train.json`. Do not edit by hand.

Detector trained on: **mps (local development run, not the MI300X)**, PyTorch 2.14.1. Training time 1613 s for 5 cross-fitting folds plus the final model (278 s for the final model alone); 89,047 parameters.

## First alarm relative to the start of each reported failure window

| Failure | Reported window (2020) | Faultline (conv autoencoder) | Static thresholds, tuned like the detector | Static thresholds at the pre-failure envelope |
|---|---|---|---|---|
| F1 | 04-18 00:00 to 04-18 23:59 | 86 min after | 44 min after | missed |
| F2 | 05-29 23:30 to 05-30 06:00 | 16 min after | 5 min after | missed |
| F3 | 06-05 10:00 to 06-07 14:30 | 21 min after | 9 min after | missed |
| F4 | 07-15 14:30 to 07-15 19:00 | 98 min before | 7.6 h before | 4 min after |

## Warning before the reported maintenance

| Failure | Maintenance | Faultline (conv autoencoder) | Static thresholds, tuned like the detector | Static thresholds at the pre-failure envelope |
|---|---|---|---|---|
| F3 | 06-08 16:00 | 77.7 h | 77.9 h | n/a |
| F4 | 07-16 00:00 | 11.1 h | 17.1 h | 9.4 h |

## Detection and false alarms

| | Faultline (conv autoencoder) | Static thresholds, tuned like the detector | Static thresholds at the pre-failure envelope |
|---|---|---|---|
| Failures detected (of 4) | 4 | 4 | 1 |
| Detected before the window start | 1 | 1 | 0 |
| False alarms | 16 | 20 | 0 |
| False alarms per week | 0.90 | 1.13 | 0.00 |
| False alarms per week of logged data | 1.11 | 1.39 | 0.00 |
| False alarms during sustained compressor load | 8 | 10 | 0 |
| Alarms in the tuning period | 9 | 12 | 0 |

False alarms are counted from 2020-04-18 to 2020-09-01, outside the failure spans: 17.8 calendar weeks, 14.4 weeks of logged data. "During sustained compressor load" counts false alarms that fired while the compressor had been under load for more than 20 minutes without a break, the same behaviour as in the reported failures, on days with no failure report.

## Settings chosen on pre-failure data

- Faultline: score above 0.2386 (the 92.50% quantile of pre-failure scores) for 30 min.
- Static thresholds, tuned like the detector: oil temperature high above 69.75 °C for 20 min; motor current high above 3.75 A for 20 min; reservoir pressure falling fast above 0.061 bar/min for 30 min.
- Static thresholds at the pre-failure envelope: oil temperature high above 83.125 °C for 1 min; motor current high above 9.295 A for 1 min; reservoir pressure falling fast above 9.052 bar/min for 1 min.

## How each method did on the pre-failure data it was tuned on

| Method | Sustained-load episodes caught within 2 h | Mean delay | Other alarms |
|---|---|---|---|
| Faultline (conv autoencoder) | 8 of 10 | 53 min | 1 |
| Static: oil temperature high | 9 of 10 | 34 min | 2 |
| Static: motor current high | 9 of 10 | 30 min | 1 |
| Static: reservoir pressure falling fast | 0 of 10 | 120 min | 0 |

Mean delay counts an episode that was not caught within 2 h as 2 h. The episodes are defined from motor current (under load for more than 20 minutes without a break), which favours the static motor-current rule: it is close to the definition itself.

## The tuned static rules, one at a time

| Rule | Failures detected | First alarm vs window start (F1 to F4) | False alarms | False alarms per week |
|---|---|---|---|---|
| Oil temperature high | 4 | 44 min after, 8 min after, 10 min after, 7.6 h before | 13 | 0.73 |
| Motor current high | 4 | 44 min after, 5 min after, 9 min after, 16 min after | 13 | 0.73 |
| Reservoir pressure falling fast | 0 | missed, missed, missed, missed | 3 | 0.17 |

## Protocol

- Training and tuning read only data before 2020-04-18 00:00:00, the start of the first reported failure. The code enforces this (`assert_pre_failure`).
- The pre-failure data contains 10 unreported episodes of sustained compressor load. Every method was tuned to detect those as early as possible with at most 2 other alarms in the pre-failure period.
- A failure counts as detected if an alarm fires from 24 h before its window starts until the window ends (or the reported maintenance, if later). Alarms outside those spans, and outside the 24 h after them, are false alarms.
- The detector needs 32 minutes of unbroken data before it can score, so it is blind for that long after every gap in the record; it scored 96.5% of the rows.
- The reported windows open within minutes of the compressor going into continuous load, so "minutes after" means minutes after the leak was already in full effect.
- Four failures is a small sample. Treat every number here as a case study, not a rate.

## Sensitivity to the lead horizon

How the result changes if alarms further ahead of a failure are credited to it.

| Horizon | Faultline (conv autoencoder): detected / false alarms per week | Static thresholds, tuned like the detector: detected / false alarms per week | Static thresholds at the pre-failure envelope: detected / false alarms per week |
|---|---|---|---|
| 2 h | 4 / 0.88 | 3 / 1.16 | 1 / 0.00 |
| 6 h | 4 / 0.89 | 3 / 1.16 | 1 / 0.00 |
| 12 h | 4 / 0.89 | 4 / 1.11 | 1 / 0.00 |
| 24 h | 4 / 0.90 | 4 / 1.13 | 1 / 0.00 |
| 48 h | 4 / 0.81 | 4 / 1.10 | 1 / 0.00 |
| 72 h | 4 / 0.77 | 4 / 1.12 | 1 / 0.00 |
| 168 h | 4 / 0.58 | 4 / 0.97 | 1 / 0.00 |
