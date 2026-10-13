import type { Metadata } from "next";
import Link from "next/link";
import { MissingData } from "@/components/MissingData";
import { attribution, fmtPct, signalShort } from "@/lib/labels";
import { loadAlarms, loadAlert } from "@/lib/server/data";
import { signalColor } from "@/lib/theme";
import { fmtDuration, trimSeconds } from "@/lib/time";

export const metadata: Metadata = { title: "Alerts" };

export default function AlertsPage() {
  const alarms = loadAlarms();
  if (alarms.length === 0) {
    return <MissingData what="The alarm list" file="results/alarms.json" fix="python -m faultline.evaluate" />;
  }
  const rows = alarms.map((alarm) => {
    const alert = loadAlert(alarm.id);
    return { alarm, hasFile: alert !== null, summary: alert?.explanation?.summary ?? null, priority: alert?.work_order?.priority ?? null };
  });
  const explained = rows.filter((r) => r.summary).length;
  const counts = new Map<string, number>();
  for (const { alarm } of rows) {
    const kind = attribution(alarm.attribution).kind;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Alerts</h1>
        <p className="lede">
          Every alarm the Faultline detector raised over the recording, newest last. Whether an alarm was a detection or a false alarm was decided afterwards, by comparing it with the operator's failure reports.
        </p>
      </div>

      <div className="tile-row" data-testid="alert-counts">
        <div className="tile">
          <span className="tile-label">Alarms</span>
          <span className="tile-value">{rows.length}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Credited to a reported failure</span>
          <span className="tile-value">{counts.get("failure") ?? 0}</span>
        </div>
        <div className="tile">
          <span className="tile-label">False alarms</span>
          <span className="tile-value">{counts.get("false") ?? 0}</span>
        </div>
        <div className="tile">
          <span className="tile-label">In the tuning period (not scored)</span>
          <span className="tile-value">{counts.get("tuning") ?? 0}</span>
        </div>
        <div className="tile">
          <span className="tile-label">With an explanation</span>
          <span className="tile-value">
            {explained} <small>of {rows.length}</small>
          </span>
        </div>
      </div>

      {explained === 0 ? (
        <p className="notice" data-testid="no-explanations">
          No explanation has been generated yet. Explanations and work orders are written by the language model on the MI300X GPU droplet, which has not been run for this data. Each alert still shows its full evidence.
        </p>
      ) : null}

      <div className="panel table-wrap">
        <table className="data-table alerts-table" data-testid="alerts-table">
          <thead>
            <tr>
              <th>Alarm</th>
              <th>Fired</th>
              <th>Active for</th>
              <th>Outcome</th>
              <th>Top contributing signals</th>
              <th>Explanation</th>
              <th>Priority</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ alarm, hasFile, summary, priority }) => {
              const info = attribution(alarm.attribution);
              return (
                <tr key={alarm.id} data-alarm-id={alarm.id} data-attribution={alarm.attribution}>
                  <td>
                    {hasFile ? (
                      <Link href={`/alerts/${alarm.id}`} className="id-link">
                        {alarm.id}
                      </Link>
                    ) : (
                      <span className="id-link" title="results/alerts has no file for this alarm">
                        {alarm.id}
                      </span>
                    )}
                  </td>
                  <td className="num nowrap">{trimSeconds(alarm.fire)}</td>
                  <td className="num nowrap">{fmtDuration(alarm.active_minutes)}</td>
                  <td>
                    <span className={`chip chip-attr-${info.kind}`} title={info.long}>
                      {info.kind === "failure" ? `Credited to failure ${info.failure}` : info.short}
                    </span>
                    {alarm.during_sustained_load ? (
                      <span className="chip chip-outline" title="Fired while the compressor had been under load for more than the sustained-load limit without a break">
                        sustained load
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <div className="sig-list">
                      {(alarm.top_signals ?? []).slice(0, 3).map((s) => (
                        <span key={s.signal} className="sig-share">
                          <i style={{ background: signalColor(s.signal) }} />
                          {signalShort(s.signal)} <b>{fmtPct(s.share)}</b>
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="summary-cell">{summary ?? <em className="muted">not generated yet</em>}</td>
                  <td>{priority ? <span className={`chip chip-${priority.toLowerCase()}`}>{priority}</span> : <em className="muted">n/a</em>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
