# Submission kit

AMD Developer Hackathon: ACT III on lablab.ai, Intelligent Industry track.
Submissions close Sunday October 18, 15:00 UTC.

Every figure to quote is in the generated block below. It is rewritten from
`results/` by `python -m faultline.report`; do not type numbers anywhere else in
the slides or the video. If the block says a figure is not measured yet, leave
it out.

## Numbers to quote

<!-- pitch:start -->
- Detected: Faultline 4 of 4 failures; conventional envelope limits 1 of 4; static rules tuned the same way 4 of 4.
- Faultline's first alarm against the start of each reported window: F1 86 min after, F2 16 min after, F3 21 min after, F4 98 min before.
- Tuned static rules, same measure: F1 44 min after, F2 5 min after, F3 9 min after, F4 7.6 h before.
- Warning before the recorded maintenance: 77.7 h (F3), 11.1 h (F4).
- False alarms per week after the first failure: Faultline 0.90, tuned static rules 1.13, envelope limits 0.00. Of Faultline's 16 false alarms, 8 fired during sustained compressor load on days with no failure report.
- Detector training took 1613 s on `mps` (a local development run, not yet the MI300X).
- Tokens per second and GPU cost per alert: not measured yet (needs the MI300X run).
<!-- pitch:end -->

<!-- status:start -->
> **Status:** the detector numbers below come from a run on `mps` (a local development run, not yet the MI300X) (finished 2026-10-13T07:53:32Z). `scripts/gpu_session.sh` reruns the same pipeline on the droplet and replaces them.
> The explanations, work orders, tokens per second and cost per alert are produced on the MI300X and are not in `results/` yet.
<!-- status:end -->

## Title

Faultline: a predictive-maintenance copilot on AMD Instinct MI300X

## Short description

Faultline watches an industrial air compressor, raises an alarm when it starts
behaving abnormally, and has an open LLM explain the likely cause with citations
to a maintenance manual and draft the technician's work order. Detector training
and all LLM inference run on one AMD Instinct MI300X.

## Long description

A compressed air leak can run for hours without tripping a conventional alarm.
Pressure, current and temperature stay inside the limits a plant would set; what
changes is the pattern, as the compressor stops cycling and runs under load
without a break. On a metro train
the air production unit has no backup, so a failure takes the vehicle out of
service.

Faultline replays seven months of real sensor data from the air production unit
of a Porto metro train (the MetroPT-3 dataset, which includes four air-leak
failures reported by the operator). A convolutional autoencoder, trained in
PyTorch on ROCm on data from before the first failure, scores each half hour of
operation against what normal looks like. When the score stays high, Faultline
raises an alarm and builds an evidence pack from the data: which signals drove
it, their values against their normal ranges, the compressor's duty cycle.

gpt-oss-120b, served by vLLM on the same MI300X, reads the evidence pack and the
most relevant passages of the US Department of Energy's compressed air
sourcebook (retrieved with Qwen3-Embedding, also on the MI300X) and returns a
structured explanation: likely causes, recommended actions and citations. Any
answer whose citations are not word-for-word in the retrieved passages is
rejected and regenerated. It then drafts a work order the technician can edit
and approve, and answers follow-up questions from the same evidence.

The benchmark compares the detector with static-threshold alarms on the four
real failures, with thresholds for both tuned only on pre-failure data. We
report it as we found it: against the limits a plant would conventionally set,
the detector catches failures they miss; a threshold rule tuned with the same
care is comparable to it. The public demo runs in replay mode from
cached results, so it keeps working after the GPU droplet is destroyed; with the
droplet up, the same app answers live.

## Tags

predictive maintenance, anomaly detection, industrial AI, AMD Instinct MI300X,
ROCm, vLLM, gpt-oss-120b, PyTorch, RAG, time series

## Slides (8)

1. **Problem.** An air leak can stay inside conventional alarm limits. Show the F2
   plot from `results/eda/failure_F2.png`: the signals in range, the compressor
   no longer cycling. One line on consequence: no redundancy, the train comes out of
   service.
2. **User.** The maintenance engineer who gets the alert at shift start. They
   need to know three things: is it real, what is the likely cause, what do I
   check first. Today they get a threshold trip with no context, or nothing.
3. **Demo.** Screenshot of the plant view mid-replay, alarm on the timeline. Then
   the alert view: evidence, explanation with a citation open, work order.
4. **How it works.** Sensor stream, autoencoder, evidence pack, retrieval, LLM
   with citation validation, work order. Use the architecture diagram from the
   README. Stress the validation loop: answers with unverifiable citations are
   rejected.
5. **AMD stack.** One MI300X, 192 GB. PyTorch on ROCm trains the detector. vLLM
   on ROCm serves gpt-oss-120b (75% of VRAM) and Qwen3-Embedding-0.6B (10%) side
   by side. No hosted LLM APIs. The whole droplet is scripted and disposable.
   Quote training time and tokens per second from the block above.
6. **Results.** The headline table from the README. Say both halves plainly:
   failures detected against conventional limits, and how a carefully tuned
   static rule compares on these four leaks (read it off the block above).
   Four failures is a case study.
7. **Business value.** Cost per alert from the block above, next to what one
   removal from service costs the operator (their number, not ours: ask the
   audience to fill it in). The work order draft is where the technician's time
   is saved. Leave out any figure the block marks as not measured.
8. **What's next.** More fault types and more units; score partial windows so
   the detector is not blind after a gap; feed technician edits and approvals
   back as labels; have an operator review the alarms now counted as false
   during sustained load.

## Video script (3:00)

| Time | Picture | Voiceover |
|---|---|---|
| 0:00-0:20 | F2 failure plot, signals in range | "This is an air leak on a metro train's compressor. The signals are inside the limits a plant would set. What changed is that the compressor stopped cycling." |
| 0:20-0:35 | Title card: Faultline | "Faultline is a maintenance copilot. It notices the pattern, explains the likely cause from the manual, and drafts the work order. Everything runs on one AMD Instinct MI300X." |
| 0:35-1:10 | Plant view, replay at 1 h/s through F2; alarm appears | "This is real data from a Porto metro train, replayed. Here the detector's score climbs and an alarm fires." Read the first-alarm figure for F2 from the block above. |
| 1:10-1:50 | Alert view: evidence, explanation, click a citation | "The alarm comes with evidence: which signals moved and how far from normal. gpt-oss-120b, served by vLLM on the MI300X, explains the likely cause and cites the Department of Energy's compressed air sourcebook. Every quotation is checked against the page it cites. If it does not match, the answer is thrown away and regenerated." |
| 1:50-2:10 | Work order: edit a step, approve; ask a chat question | "It drafts the work order. The technician edits it, approves it, and can ask follow-up questions against the same evidence." |
| 2:10-2:40 | Benchmark view | Read the detected counts, the lead times and the false alarm rates from the block above. "We tuned everything on data from before the first failure. Against conventional limits the detector catches leaks they miss. A static rule tuned just as carefully is comparable on these four, and we show that too." |
| 2:40-3:00 | AMD stack slide, then repo URL | "Training in PyTorch on ROCm, a 120-billion-parameter open model and an embedding model side by side in vLLM, on one GPU." Read tokens per second and cost per alert from the block above if measured. "The code and every result are in the repository." |

## Checklist before submitting

- [ ] `results/bench.json` says `trained_on_mi300x: true`.
- [ ] `results/llm/summary.json` exists and `python -m faultline.explain --check` passes.
- [ ] `python -m faultline.report --check` passes.
- [ ] The public URL loads and replays F2 end to end.
- [ ] The droplet is destroyed, or deliberately left up for live mode during judging.
- [ ] Cover image is `docs/cover.png` (1200x630), a screenshot of the app's `/cover`
      page. Regenerate it after the MI300X run: `cd apps/web && pnpm build && pnpm start`,
      then `pnpm cover` in another terminal.
