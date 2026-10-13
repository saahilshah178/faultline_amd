import type { Metadata } from "next";
import { LeadChart } from "@/components/benchmark/LeadChart";
import { MissingData } from "@/components/MissingData";
import { RULE_LABEL, fmtInt, fmtLead, fmtLeadLong, fmtNum, fmtSeconds } from "@/lib/labels";
import { loadBench, loadLlmSummary, loadSecondBench } from "@/lib/server/data";
import { methodColor } from "@/lib/theme";
import { trimSeconds } from "@/lib/time";
import type { Bench, Method, RuleParams } from "@/lib/types";

export const metadata: Metadata = { title: "Benchmark" };

// Every figure on this page is read from results/bench.json (and results/llm/summary.json
// when it exists). The sentences around them carry no numbers of their own.

function Key({ method }: { method: Method }) {
  return <i className="swatch" style={{ background: methodColor(method.key) }} />;
}

function settings(method: Method): string[] {
  if (method.kind === "detector") {
    const p = method.params as { threshold?: number; threshold_quantile?: number; duration_s?: number; smoothing?: string };
    return [
      `Alarm when the reconstruction score stays above ${p.threshold ?? "n/a"} for ${fmtSeconds(p.duration_s)}` +
        (p.threshold_quantile !== undefined ? ` (the ${(p.threshold_quantile * 100).toFixed(2)}% quantile of pre-failure scores)` : "") +
        (p.smoothing ? `; score smoothed over ${p.smoothing}` : ""),
    ];
  }
  return Object.entries(method.params as Record<string, RuleParams>).map(
    ([rule, p]) =>
      `${RULE_LABEL[rule] ?? rule}: above ${p.threshold} ${p.unit ?? ""} for ${fmtSeconds(p.duration_s)}` +
      (p.quantile !== undefined ? ` (pre-failure quantile ${p.quantile})` : ""),
  );
}

/** Plain comparison of each baseline with the detector, worded from the numbers themselves. */
function comparisons(bench: Bench): string[] {
  const detector = bench.methods.find((m) => m.kind === "detector");
  if (!detector) return [];
  const total = detector.failures.length;
  const word = (a: number, b: number, more: string, fewer: string, same: string) => (a > b ? more : a < b ? fewer : same);
  return bench.methods
    .filter((m) => m !== detector)
    .map((m) => {
      const d = detector.summary;
      const s = m.summary;
      const detection = word(s.failures_detected, d.failures_detected, "more", "fewer", "as many");
      const alarms = word(s.false_alarms_per_week, d.false_alarms_per_week, "more", "fewer", "the same number of");
      // Who fired first, for the failures both of them caught.
      let both = 0;
      let baselineFirst = 0;
      let detectorFirst = 0;
      for (const f of detector.failures) {
        const other = m.failures.find((x) => x.id === f.id);
        if (!f.detected || !other?.detected || f.lead_before_start_h === null || other.lead_before_start_h === null) continue;
        both++;
        if (other.lead_before_start_h > f.lead_before_start_h) baselineFirst++;
        else if (other.lead_before_start_h < f.lead_before_start_h) detectorFirst++;
      }
      const order = both
        ? ` For the ${both} failure${both === 1 ? "" : "s"} both caught, it fired first ${baselineFirst} time${baselineFirst === 1 ? "" : "s"} and the detector fired first ${detectorFirst} time${detectorFirst === 1 ? "" : "s"}.`
        : "";
      return (
        `${m.label} detected ${detection} failures ${detection === "as many" ? "as" : "than"} the detector ` +
        `(${s.failures_detected} of ${total} against ${d.failures_detected} of ${total}) with ${alarms} false alarms per week ` +
        `(${fmtNum(s.false_alarms_per_week)} against ${fmtNum(d.false_alarms_per_week)}).${order}`
      );
    });
}

export default function BenchmarkPage() {
  const bench = loadBench();
  if (!bench || !bench.methods?.length) {
    return <MissingData what="The benchmark" file="results/bench.json" fix="python -m faultline.evaluate" />;
  }
  const llm = loadLlmSummary();
  const second = loadSecondBench();
  const methods = bench.methods;
  const failures = methods[0].failures;
  const withMaintenance = failures.filter((f) => f.maintenance);
  const protocol = bench.protocol ?? {};
  const period = protocol.evaluation_period;
  const training = bench.training;
  const hardware = training?.hardware;
  const horizons = Object.entries(bench.sensitivity?.lead_horizon_h ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  const proxies = bench.pre_failure_sustained_load_episodes?.length;

  return (
    <div className="stack benchmark" data-testid="benchmark">
      <div className="page-head">
        <h1>Benchmark</h1>
        <p className="lede">
          The detector against two static-threshold rules on the same recording, scored against the operator's failure reports.
          {bench.generated_utc ? ` Generated ${bench.generated_utc.replace("T", " ").replace("Z", " UTC")} by the evaluation script.` : ""}
        </p>
      </div>

      <section className="panel reading" data-testid="reading">
        <h2>How to read this result</h2>
        <ul>
          {comparisons(bench).map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>
            {failures.length} reported failures is a small sample. Treat every figure here as a case study, not a rate.
          </li>
        </ul>
      </section>

      <section className="panel">
        <header className="section-head">
          <h2>Detection and false alarms</h2>
          {period ? (
            <span className="muted">
              false alarms counted from {trimSeconds(period.start ?? "")} to {trimSeconds(period.end ?? "")}: {period.calendar_weeks} calendar weeks, {period.observed_weeks} weeks of logged data
            </span>
          ) : null}
        </header>
        <div className="table-wrap">
          <table className="data-table summary-table" data-testid="summary-table">
            <thead>
              <tr>
                <th />
                {methods.map((m) => (
                  <th key={m.key}>
                    <Key method={m} />
                    {m.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Failures detected</th>
                {methods.map((m) => (
                  <td key={m.key} className="num" data-method={m.key} data-field="failures_detected" data-value={m.summary.failures_detected}>
                    <strong>{m.summary.failures_detected}</strong> of {m.failures.length}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">Detected before the window opened</th>
                {methods.map((m) => (
                  <td key={m.key} className="num" data-method={m.key} data-field="detected_before_window_start" data-value={m.summary.detected_before_window_start}>
                    {m.summary.detected_before_window_start ?? "n/a"}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">False alarms</th>
                {methods.map((m) => (
                  <td key={m.key} className="num" data-method={m.key} data-field="false_alarms" data-value={m.summary.false_alarms}>
                    {m.summary.false_alarms}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">False alarms per week</th>
                {methods.map((m) => (
                  <td key={m.key} className="num" data-method={m.key} data-field="false_alarms_per_week" data-value={m.summary.false_alarms_per_week}>
                    <strong>{fmtNum(m.summary.false_alarms_per_week)}</strong>
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">False alarms per week of logged data</th>
                {methods.map((m) => (
                  <td key={m.key} className="num" data-method={m.key} data-field="false_alarms_per_observed_week" data-value={m.summary.false_alarms_per_observed_week}>
                    {fmtNum(m.summary.false_alarms_per_observed_week)}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">False alarms during sustained compressor load</th>
                {methods.map((m) => (
                  <td key={m.key} className="num" data-method={m.key} data-field="false_alarms_during_sustained_load" data-value={m.summary.false_alarms_during_sustained_load}>
                    {m.summary.false_alarms_during_sustained_load ?? "n/a"}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">Alarms in the tuning period (not scored)</th>
                {methods.map((m) => (
                  <td key={m.key} className="num" data-method={m.key} data-field="alarms_in_tuning_period" data-value={m.summary.alarms_in_tuning_period}>
                    {m.summary.alarms_in_tuning_period ?? "n/a"}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        {protocol.tuning?.sustained_load_min_s !== undefined ? (
          <p className="hint">
            "During sustained compressor load" counts false alarms that fired while the compressor had been under load for more than {fmtSeconds(protocol.tuning.sustained_load_min_s)} without a break, the behaviour seen in the reported failures, on days with no failure report.
          </p>
        ) : null}
      </section>

      <section className="panel">
        <header className="section-head">
          <h2>First alarm relative to the start of each reported failure window</h2>
        </header>
        <LeadChart methods={methods} />
        <div className="table-wrap">
          <table className="data-table lead-table" data-testid="lead-table">
            <thead>
              <tr>
                <th>Failure</th>
                <th>Reported window</th>
                {methods.map((m) => (
                  <th key={m.key}>
                    <Key method={m} />
                    {m.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {failures.map((f) => (
                <tr key={f.id}>
                  <th scope="row">{f.id}</th>
                  <td className="num nowrap">
                    {trimSeconds(f.window_start)} to {trimSeconds(f.window_end)}
                  </td>
                  {methods.map((m) => {
                    const r = m.failures.find((x) => x.id === f.id);
                    const missed = !r?.detected;
                    return (
                      <td
                        key={m.key}
                        data-method={m.key}
                        data-failure={f.id}
                        data-detected={missed ? "0" : "1"}
                        data-value={r?.lead_before_start_h ?? ""}
                        className={missed ? "is-missed" : (r?.lead_before_start_h ?? 0) > 0 ? "is-before" : "is-after"}
                      >
                        <strong>{fmtLeadLong(r?.lead_before_start_h, !missed)}</strong>
                        {r?.first_alarm ? <span className="sub">first alarm {trimSeconds(r.first_alarm)}</span> : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {withMaintenance.length ? (
        <section className="panel">
          <header className="section-head">
            <h2>Warning before the reported maintenance</h2>
            <span className="muted">for the failures that have a maintenance time on record</span>
          </header>
          <div className="table-wrap">
            <table className="data-table" data-testid="maintenance-table">
              <thead>
                <tr>
                  <th>Failure</th>
                  <th>Maintenance</th>
                  {methods.map((m) => (
                    <th key={m.key}>
                      <Key method={m} />
                      {m.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {withMaintenance.map((f) => (
                  <tr key={f.id}>
                    <th scope="row">{f.id}</th>
                    <td className="num nowrap">{trimSeconds(f.maintenance ?? "")}</td>
                    {methods.map((m) => {
                      const r = m.failures.find((x) => x.id === f.id);
                      const h = r?.lead_before_maintenance_h;
                      return (
                        <td key={m.key} className="num" data-method={m.key} data-failure={f.id} data-value={h ?? ""}>
                          {h === null || h === undefined ? <em className="muted">no alarm</em> : <strong>{fmtNum(h, 1)} h before</strong>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {second?.methods?.length ? (
        <section className="panel" data-testid="second-test">
          <header className="section-head">
            <h2>Second test: {second.dataset?.name ?? "another recording"}</h2>
            <span className="muted">
              a later recording from the same operator, {(second.dataset?.start ?? "").slice(0, 10)} to {(second.dataset?.end ?? "").slice(0, 10)}
            </span>
          </header>
          <p className="hint">
            Nothing about the detector, the static rules or the tuning procedure was chosen with this recording. The same code was run on it
            afterwards, trained and tuned only on its own data from before {trimSeconds(second.protocol?.training_cutoff ?? "")}.{" "}
            {second.training?.trained_on_mi300x
              ? "Trained on the MI300X."
              : `Trained on ${second.training?.hardware?.gpu_name ?? second.training?.hardware?.device ?? "an unrecorded device"}: a local development run, not the MI300X.`}
          </p>
          <div className="table-wrap">
            <table className="data-table lead-table" data-testid="second-test-table">
              <thead>
                <tr>
                  <th>Method</th>
                  {second.methods[0].failures.map((f) => (
                    <th key={f.id}>
                      {f.id}
                      {f.failure ? `: ${f.failure.toLowerCase()}` : ""}
                      <span className="sub">reported {trimSeconds(f.window_start)}</span>
                    </th>
                  ))}
                  <th>False alarms</th>
                  <th>False alarms per week</th>
                </tr>
              </thead>
              <tbody>
                {second.methods.map((m) => (
                  <tr key={m.key}>
                    <th scope="row">
                      <Key method={m} />
                      {m.label}
                    </th>
                    {m.failures.map((r) => (
                      <td
                        key={r.id}
                        data-method={m.key}
                        data-failure={r.id}
                        data-value={r.lead_before_start_h ?? ""}
                        className={!r.detected ? "is-missed" : (r.lead_before_start_h ?? 0) > 0 ? "is-before" : "is-after"}
                      >
                        <strong>{fmtLeadLong(r.lead_before_start_h, r.detected)}</strong>
                        {r.first_alarm ? <span className="sub">first alarm {trimSeconds(r.first_alarm)}</span> : null}
                      </td>
                    ))}
                    <td className="num">{fmtInt(m.summary.false_alarms)}</td>
                    <td className="num">{fmtNum(m.summary.false_alarms_per_week)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">
            False alarms counted over {second.protocol?.evaluation_period?.calendar_weeks} calendar weeks after the first failure.{" "}
            {second.methods[0].failures.length} reported failures: a case study, not a rate.
          </p>
        </section>
      ) : null}

      {horizons.length ? (
        <section className="panel">
          <header className="section-head">
            <h2>Sensitivity to the lead horizon</h2>
            <span className="muted">how the result changes if alarms further ahead of a failure are credited to it</span>
          </header>
          <div className="table-wrap">
            <table className="data-table" data-testid="sensitivity-table">
              <thead>
                <tr>
                  <th>Horizon</th>
                  {methods.map((m) => (
                    <th key={m.key}>
                      <Key method={m} />
                      {m.label}
                      <span className="sub">detected, false alarms per week</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {horizons.map(([h, row]) => (
                  <tr key={h} className={Number(h) === protocol.lead_horizon_h ? "is-chosen" : ""}>
                    <th scope="row">
                      {h} h{Number(h) === protocol.lead_horizon_h ? <span className="sub">used above</span> : null}
                    </th>
                    {methods.map((m) => {
                      const cell = row[m.key];
                      return (
                        <td key={m.key} className="num" data-method={m.key} data-horizon={h} data-detected={cell?.failures_detected} data-value={cell?.false_alarms_per_week}>
                          {cell ? (
                            <>
                              {cell.failures_detected} of {m.failures.length}, {fmtNum(cell.false_alarms_per_week)}
                            </>
                          ) : (
                            "n/a"
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <div className="two-col">
        <section className="panel">
          <header className="section-head">
            <h2>Settings chosen on pre-failure data</h2>
          </header>
          <dl className="settings" data-testid="settings">
            {methods.map((m) => (
              <div key={m.key}>
                <dt>
                  <Key method={m} />
                  {m.label}
                </dt>
                <dd>
                  <ul>
                    {settings(m).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="panel">
          <header className="section-head">
            <h2>Protocol</h2>
          </header>
          <ul className="notes" data-testid="protocol">
            {protocol.training_cutoff ? <li>Training and tuning read only data before {protocol.training_cutoff}, the start of the first reported failure. The pipeline enforces this in code.</li> : null}
            {proxies !== undefined && protocol.tuning?.max_other_alarms !== undefined ? (
              <li>
                The pre-failure data contains {proxies} unreported episodes of sustained compressor load. Every method was tuned to detect those as early as possible with at most {protocol.tuning.max_other_alarms} other alarms in the pre-failure period.
              </li>
            ) : null}
            {protocol.lead_horizon_h !== undefined ? (
              <li>
                A failure counts as detected if an alarm fires from {protocol.lead_horizon_h} h before its window starts until the window ends, or until the reported maintenance if that is later.
                {protocol.post_buffer_h !== undefined ? ` Alarms outside those spans, and outside the ${protocol.post_buffer_h} h after them, are false alarms.` : ""}
              </li>
            ) : null}
            {protocol.alarm_clear_s !== undefined ? <li>An active alarm clears once its condition has been absent for {fmtSeconds(protocol.alarm_clear_s)} of logged time.</li> : null}
            {period?.excluded_hours !== undefined ? <li>{period.excluded_hours} hours inside the failure spans and the buffers after them are left out of the false alarm count and of the weeks it is divided by.</li> : null}
            {bench.dataset ? (
              <li>
                Data: {bench.dataset.name}, {fmtInt(bench.dataset.rows)} rows at {bench.dataset.interval_s} s intervals, {trimSeconds(bench.dataset.start ?? "")} to {trimSeconds(bench.dataset.end ?? "")} ({bench.dataset.license}).
              </li>
            ) : null}
          </ul>
        </section>
      </div>

      <div className="two-col">
        <section className="panel" data-testid="training">
          <header className="section-head">
            <h2>Where the detector was trained</h2>
            {training ? (
              <span className={`chip ${training.trained_on_mi300x ? "chip-good" : "chip-muted"}`} data-testid="trained-on" data-mi300x={training.trained_on_mi300x ? "1" : "0"}>
                {training.trained_on_mi300x ? "trained on the MI300X" : "not trained on the MI300X"}
              </span>
            ) : null}
          </header>
          {training ? (
            <>
              <p data-testid="trained-device">
                Trained on <code>{hardware?.device ?? "an unrecorded device"}</code>
                {hardware?.gpu_name ? ` (${hardware.gpu_name}${hardware.gpu_memory_gb ? `, ${hardware.gpu_memory_gb} GB` : ""})` : ""}
                {training.trained_on_mi300x ? "." : ": a local development run, not the MI300X."}
                {hardware?.torch ? ` PyTorch ${hardware.torch}` : ""}
                {hardware?.hip ? `, ROCm/HIP ${hardware.hip}` : ""}
                {hardware?.cuda ? `, CUDA ${hardware.cuda}` : ""}
                {hardware?.torch ? "." : ""}
              </p>
              <div className="tile-row">
                <div className="tile">
                  <span className="tile-label">Training time, all folds and the final model</span>
                  <span className="tile-value" data-testid="train-seconds" data-value={training.train_seconds_total}>
                    {fmtInt(training.train_seconds_total)} <small>s</small>
                  </span>
                </div>
                <div className="tile">
                  <span className="tile-label">Final model alone</span>
                  <span className="tile-value" data-value={training.train_seconds_final_model}>
                    {fmtInt(training.train_seconds_final_model)} <small>s</small>
                  </span>
                </div>
                <div className="tile">
                  <span className="tile-label">Parameters</span>
                  <span className="tile-value" data-value={training.parameters}>
                    {fmtInt(training.parameters)}
                  </span>
                </div>
                <div className="tile">
                  <span className="tile-label">Windows scored per second</span>
                  <span className="tile-value">{fmtInt(training.score_windows_per_second)}</span>
                </div>
              </div>
              {training.config ? (
                <details>
                  <summary>Model and training configuration</summary>
                  <dl className="config">
                    {Object.entries(training.config).map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{Array.isArray(v) ? v.join(", ") : String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ) : null}
              {training.run ? (
                <p className="hint">
                  Run finished {training.run.finished_utc?.replace("T", " ").replace("Z", " UTC")} on {training.run.platform}
                  {training.run.git_commit ? `, commit ${training.run.git_commit}` : ""}.
                </p>
              ) : null}
            </>
          ) : (
            <p className="muted">bench.json has no training block.</p>
          )}
        </section>

        <section className="panel" data-testid="llm-summary" data-state={llm ? "ready" : "missing"}>
          <header className="section-head">
            <h2>Explanations on the GPU</h2>
          </header>
          {llm ? (
            <>
              <p>
                <code>{llm.model ?? "model not recorded"}</code> wrote explanations for {llm.alerts} alerts in {llm.calls} calls; {llm.calls_rejected_and_retried} of those calls were retries after the validator rejected a reply.
              </p>
              <div className="tile-row">
                <div className="tile">
                  <span className="tile-label">Tokens per second, median</span>
                  <span className="tile-value" data-testid="llm-tps" data-value={llm.tokens_per_s?.median ?? ""}>
                    {llm.tokens_per_s?.median ?? "n/a"}
                  </span>
                  <span className="tile-sub">
                    10th to 90th percentile {llm.tokens_per_s?.p10 ?? "n/a"} to {llm.tokens_per_s?.p90 ?? "n/a"}; aggregate {llm.tokens_per_s?.aggregate ?? "n/a"}
                  </span>
                </div>
                <div className="tile">
                  <span className="tile-label">Seconds of model time per alert, median</span>
                  <span className="tile-value">{llm.seconds_per_alert?.median ?? "n/a"}</span>
                  <span className="tile-sub">longest {llm.seconds_per_alert?.max ?? "n/a"}</span>
                </div>
                <div className="tile">
                  <span className="tile-label">GPU cost per alert, one at a time</span>
                  <span className="tile-value" data-testid="llm-usd" data-value={llm.usd_per_alert?.one_at_a_time ?? ""}>
                    {llm.usd_per_alert?.one_at_a_time !== undefined ? `$${llm.usd_per_alert.one_at_a_time}` : "n/a"}
                  </span>
                  {llm.batch?.usd_per_alert !== undefined ? <span className="tile-sub">${llm.batch.usd_per_alert} per alert in the concurrent batch of {llm.batch.alerts}</span> : null}
                </div>
              </div>
              <p className="hint">
                {llm.tokens_per_s?.note ? `Tokens per second: ${llm.tokens_per_s.note}. ` : ""}
                {llm.gpu_price ? (
                  <>
                    Price used: ${llm.gpu_price.usd_per_hour} per hour for {llm.gpu_price.instance}
                    {llm.gpu_price.source ? (
                      <>
                        {" "}
                        (<a href={llm.gpu_price.source} target="_blank" rel="noreferrer noopener">price source</a>)
                      </>
                    ) : null}
                    .
                  </>
                ) : null}
              </p>
            </>
          ) : (
            <div className="not-generated" data-testid="llm-summary-missing">
              <strong>Not measured yet.</strong>
              <p>
                Tokens per second and GPU cost per alert are measured when the explanations are generated on the MI300X droplet. That run has not happened for this data, so <code>results/llm/summary.json</code> does not exist and no figure is shown.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
