import { DIGITAL_LABEL, fmtNum, fmtPct } from "@/lib/labels";
import { signalColor } from "@/lib/theme";
import { trimSeconds } from "@/lib/time";
import type { Evidence, ReplaySignal, SignalEvidence } from "@/lib/types";

// The evidence pack exactly as the pipeline computed it, laid out to be scanned:
// what was read in the hour before the alarm, next to what is normal.

const num = (v: number | null | undefined, digits = 2) => (v === null || v === undefined ? "n/a" : fmtNum(v, digits));

/** Observed min-max (line) and mean (dot) against the normal p05-p95 band, on a shared scale. */
function RangeBar({ stats, normal }: { stats: SignalEvidence["window"]; normal?: [number, number] }) {
  if (!stats || stats.min === null || stats.max === null || !normal) return <span className="muted">n/a</span>;
  const lo = Math.min(stats.min, normal[0]);
  const hi = Math.max(stats.max, normal[1]);
  const span = hi - lo || 1;
  const pos = (v: number) => ((v - lo) / span) * 100;
  return (
    <span className="range" role="img" aria-label={`observed ${stats.min} to ${stats.max}, normal ${normal[0]} to ${normal[1]}`}>
      <i className="range-normal" style={{ left: `${pos(normal[0])}%`, width: `${Math.max(pos(normal[1]) - pos(normal[0]), 1.5)}%` }} />
      <i className="range-observed" style={{ left: `${pos(stats.min)}%`, width: `${Math.max(pos(stats.max) - pos(stats.min), 1.5)}%` }} />
      {stats.mean !== null ? <i className="range-mean" style={{ left: `${pos(stats.mean)}%` }} /> : null}
    </span>
  );
}

function Verdict({ text }: { text?: string }) {
  if (!text) return <span className="muted">n/a</span>;
  const off = text !== "within normal";
  return <span className={`chip ${off ? "chip-alarm" : "chip-muted"}`}>{text}</span>;
}

function Compare({ label, value, normal }: { label: string; value: string; normal?: string }) {
  return (
    <div className="kv">
      <dt>{label}</dt>
      <dd>
        <strong>{value}</strong>
        {normal ? <span className="kv-normal">normal: {normal}</span> : null}
      </dd>
    </div>
  );
}

export function EvidencePanel({ evidence, signals }: { evidence: Evidence; signals: ReplaySignal[] }) {
  const detector = evidence.detector;
  const duty = evidence.compressor_duty;
  const trend = evidence.trend;
  const share = new Map((evidence.top_contributing_signals ?? []).map((s) => [s.signal, s.share_of_error]));
  const label = (key: string) => signals.find((s) => s.key === key)?.label ?? key;
  const rows: [string, SignalEvidence][] = evidence.signals
    ? Object.entries(evidence.signals)
    : (evidence.top_contributing_signals ?? []).map((s) => [s.signal ?? "", s]);
  const state = duty?.state_share_last_60min;
  const pct = (v: number | null | undefined) => fmtPct(v, 1);
  const quantiles = (q?: { p50: number; p95: number; p99?: number }, fmt: (v: number) => string = (v) => String(v)) =>
    q ? `median ${fmt(q.p50)}, 95th percentile ${fmt(q.p95)}${q.p99 !== undefined ? `, 99th ${fmt(q.p99)}` : ""}` : undefined;

  return (
    <section className="panel evidence" data-testid="evidence">
      <header className="section-head">
        <h2>Evidence</h2>
        <span className="muted">
          computed from the sensor data{evidence.window ? `, ${trimSeconds(evidence.window.start)} to ${trimSeconds(evidence.window.end).slice(11)}` : ""}
        </span>
      </header>

      {detector ? (
        <div className="evidence-score" data-testid="evidence-score">
          <div>
            <span className="tile-label">Detector score at the alarm</span>
            <span className="tile-value" data-value={detector.score_at_alarm}>
              {detector.score_at_alarm}
            </span>
          </div>
          <div>
            <span className="tile-label">Threshold</span>
            <span className="tile-value" data-value={detector.threshold}>
              {detector.threshold}
            </span>
          </div>
          <div>
            <span className="tile-label">Score over threshold</span>
            <span className="tile-value" data-value={detector.score_over_threshold}>
              {detector.score_over_threshold}×
            </span>
          </div>
          {evidence.minutes_from_onset_to_alarm !== undefined ? (
            <div>
              <span className="tile-label">Anomaly began to alarm</span>
              <span className="tile-value">
                {evidence.minutes_from_onset_to_alarm} <small>min</small>
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {rows.length ? (
        <div className="table-wrap">
          <table className="data-table evidence-table" data-testid="evidence-signals">
            <thead>
              <tr>
                <th>Signal</th>
                <th>{evidence.window?.minutes ? `Last ${evidence.window.minutes} min before the alarm` : "Before the alarm"}: mean (min to max)</th>
                <th>Normal (5th to 95th percentile)</th>
                <th>
                  Observed against normal
                  <span className="th-key">
                    <i className="key key-normal" /> normal <i className="key key-observed" /> observed
                  </span>
                </th>
                <th>While under load: mean (normal)</th>
                <th>Verdict under load</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([key, s]) => (
                <tr key={key} data-signal={key} className={share.has(key) ? "is-top" : ""}>
                  <th scope="row">
                    <i className="dot" style={{ background: signalColor(key) }} />
                    {label(key)}
                    {share.has(key) ? <span className="share-tag">{fmtPct(share.get(key), 0)} of error</span> : null}
                  </th>
                  <td className="num">
                    <strong>{num(s.window?.mean)}</strong> {s.unit} <span className="muted">({num(s.window?.min)} to {num(s.window?.max)})</span>
                  </td>
                  <td className="num">{s.normal_p05_p95 ? `${s.normal_p05_p95[0]} to ${s.normal_p05_p95[1]} ${s.unit ?? ""}` : "n/a"}</td>
                  <td>
                    <RangeBar stats={s.window} normal={s.normal_p05_p95} />
                  </td>
                  <td className="num">
                    {s.under_load ? (
                      <>
                        <strong>{num(s.under_load.mean)}</strong> {s.unit}{" "}
                        <span className="muted">({s.under_load.normal_p05_p95 ? `${s.under_load.normal_p05_p95[0]} to ${s.under_load.normal_p05_p95[1]}` : "n/a"})</span>
                      </>
                    ) : (
                      <span className="muted">not under load in this window</span>
                    )}
                  </td>
                  <td>{s.under_load ? <Verdict text={s.under_load.verdict} /> : <span className="muted">n/a</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="evidence-cols">
        {duty ? (
          <div data-testid="evidence-duty">
            <h3>Compressor duty</h3>
            <dl className="kv-list">
              <Compare label="Under load, last 30 min" value={pct(duty.under_load_share_last_30min)} normal={quantiles(duty.normal_under_load_share_30min, (v) => pct(v))} />
              <Compare label="Under load, last 60 min" value={pct(duty.under_load_share_last_60min)} />
              <Compare label="Under load, last 2 h" value={pct(duty.under_load_share_last_2h)} />
              <Compare
                label="Continuous load when the alarm fired"
                value={`${num(duty.continuous_load_minutes_at_alarm, 1)} min`}
                normal={quantiles(duty.normal_loaded_run_minutes, (v) => `${fmtNum(v, 1)} min`)}
              />
              <Compare label="Longest loaded run, last 60 min" value={`${num(duty.longest_loaded_run_minutes_last_60min, 1)} min`} />
              <Compare
                label="Load starts, last 2 h"
                value={duty.load_starts_last_2h === null || duty.load_starts_last_2h === undefined ? "n/a" : String(duty.load_starts_last_2h)}
                normal={duty.normal_starts_per_hour ? `${quantiles(duty.normal_starts_per_hour)} per hour` : undefined}
              />
            </dl>
            {state ? (
              <div className="state-share">
                <span className="tile-label">Operating state, last 60 min</span>
                <div className="stack-bar" role="img" aria-label={`off ${pct(state.off)}, offloaded ${pct(state.offloaded)}, loaded ${pct(state.loaded)}`}>
                  <i className="st-off" style={{ flexGrow: state.off }} />
                  <i className="st-offloaded" style={{ flexGrow: state.offloaded }} />
                  <i className="st-loaded" style={{ flexGrow: state.loaded }} />
                </div>
                <div className="stack-legend">
                  <span>
                    <i className="key st-off" /> off {pct(state.off)}
                  </span>
                  <span>
                    <i className="key st-offloaded" /> running offloaded {pct(state.offloaded)}
                  </span>
                  <span>
                    <i className="key st-loaded" /> under load {pct(state.loaded)}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div>
          {trend ? (
            <>
              <h3>Trend</h3>
              <dl className="kv-list">
                {"oil_temperature_max_last_60min" in trend ? <Compare label="Oil temperature, highest in the last 60 min" value={`${num(trend.oil_temperature_max_last_60min)} °C`} /> : null}
                {"oil_temperature_mean_previous_24h" in trend ? <Compare label="Oil temperature, mean over the previous 24 h" value={`${num(trend.oil_temperature_mean_previous_24h)} °C`} /> : null}
                {"reservoir_pressure_min_last_60min" in trend ? <Compare label="Reservoir pressure, lowest in the last 60 min" value={`${num(trend.reservoir_pressure_min_last_60min)} bar`} /> : null}
                {"under_load_share_previous_24h" in trend ? <Compare label="Under load, previous 24 h" value={pct(trend.under_load_share_previous_24h)} /> : null}
              </dl>
            </>
          ) : null}
          {evidence.data_quality ? (
            <>
              <h3>Data quality</h3>
              <dl className="kv-list">
                <Compare label="Rows in the window" value={String(evidence.data_quality.rows_in_window ?? "n/a")} />
                <Compare label="Share of the window logged" value={fmtPct(evidence.data_quality.share_of_window_logged, 0)} />
              </dl>
            </>
          ) : null}
        </div>
      </div>

      {evidence.digital_signals ? (
        <details className="digital">
          <summary>On/off signals in the last 60 min</summary>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Signal</th>
                  <th>Share of time on</th>
                  <th>Normal share on</th>
                  <th>Switches</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(evidence.digital_signals).map(([key, d]) => (
                  <tr key={key}>
                    <th scope="row">{DIGITAL_LABEL[key] ?? key}</th>
                    <td className="num">{pct(d.share_on_last_60min)}</td>
                    <td className="num">{pct(d.normal_share_on)}</td>
                    <td className="num">{d.switches_last_60min ?? "n/a"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  );
}
