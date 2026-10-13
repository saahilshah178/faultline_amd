# Earlier runs

Kept so that the one change made to the detector after its first full evaluation
is on the record.

## first_design

The first detector trained on every pre-failure window, relying only on dropping
the highest-loss 10% of each batch to keep abnormal data out. `bench.json` and
`bench.md` in `first_design/` are that run, unedited (a local development run).

Its tuning table showed the problem without any failure data: on the pre-failure
period it caught 2 of the 10 unreported sustained-load episodes, because it had
been trained on them and had learned to reconstruct them. The fix was to leave
the windows that touch those episodes out of training
(`DetectorConfig.exclude_sustained_load`). The episodes are found from
pre-failure motor current alone, so the change uses no failure data, but it was
made after seeing the first full evaluation, and that is why the first run is
kept here.
