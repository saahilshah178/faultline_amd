import { fmtLead } from "@/lib/labels";
import { methodColor } from "@/lib/theme";
import type { Method } from "@/lib/types";

// First alarm relative to the start of each reported failure window. One axis in
// hours: left of the zero line is warning before the window opened, right is after.
// A missed failure has no mark, only the word "missed": it is not a zero.

const ROW = 22;
const GROUP_GAP = 18;
const LEFT = 86;
const RIGHT = 150;
const TOP = 34;

function niceStep(span: number): number {
  for (const step of [0.25, 0.5, 1, 2, 4, 6, 12, 24, 48]) if (span / step <= 9) return step;
  return 96;
}

export function LeadChart({ methods }: { methods: Method[] }) {
  const failures = methods[0]?.failures.map((f) => f.id) ?? [];
  const leads = methods.flatMap((m) => m.failures.filter((f) => f.detected && f.lead_before_start_h !== null).map((f) => f.lead_before_start_h as number));
  // x is hours after the window start (negative = before), so time runs left to right.
  const lo = Math.min(0, ...leads.map((h) => -h));
  const hi = Math.max(0, ...leads.map((h) => -h));
  const span = hi - lo || 1;
  const step = niceStep(span);
  const min = Math.floor((lo - span * 0.04) / step) * step;
  const max = Math.ceil((hi + span * 0.04) / step) * step;
  const width = 860;
  const plot = width - LEFT - RIGHT;
  const x = (hoursAfter: number) => LEFT + ((hoursAfter - min) / (max - min)) * plot;
  const groupHeight = methods.length * ROW + GROUP_GAP;
  const height = TOP + failures.length * groupHeight + 26;
  const ticks: number[] = [];
  for (let t = min; t <= max + 1e-9; t += step) ticks.push(Math.round(t * 100) / 100);
  const tickLabel = (t: number) => (t === 0 ? "window opens" : `${Math.abs(t)} h ${t < 0 ? "before" : "after"}`);

  return (
    <figure className="lead-chart" data-testid="lead-chart">
      <div className="legend" aria-hidden>
        {methods.map((m) => (
          <span key={m.key}>
            <i style={{ background: methodColor(m.key) }} />
            {m.label}
          </span>
        ))}
      </div>
      <div className="lead-scroll">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="First alarm relative to the start of each reported failure window, by method">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={TOP - 6} y2={height - 22} className={t === 0 ? "zero-line" : "grid-line"} />
              <text x={x(t)} y={TOP - 14} textAnchor="middle" className={t === 0 ? "axis-text axis-zero" : "axis-text"}>
                {tickLabel(t)}
              </text>
            </g>
          ))}
          {failures.map((fid, gi) => {
            const top = TOP + gi * groupHeight;
            return (
              <g key={fid}>
                <text x={12} y={top + (methods.length * ROW) / 2 + 4} className="group-label">
                  {fid}
                </text>
                {methods.map((m, mi) => {
                  const f = m.failures.find((r) => r.id === fid);
                  const y = top + mi * ROW + ROW / 2;
                  const detected = !!f?.detected && f.lead_before_start_h !== null && f.lead_before_start_h !== undefined;
                  const text = fmtLead(f?.lead_before_start_h, detected);
                  if (!detected) {
                    return (
                      <g key={m.key} data-method={m.key} data-failure={fid} data-missed="1">
                        <title>{`${m.label}, ${fid}: missed`}</title>
                        <rect x={LEFT} y={y - ROW / 2} width={plot} height={ROW} fill="transparent" />
                        <circle cx={x(0) + 12} cy={y} r={4} fill="none" stroke={methodColor(m.key)} strokeWidth={1.5} />
                        <text x={x(0) + 24} y={y + 4} className="missed-text">
                          {text}
                        </text>
                      </g>
                    );
                  }
                  const at = x(-(f!.lead_before_start_h as number));
                  const labelRight = at >= x(0);
                  return (
                    <g key={m.key} data-method={m.key} data-failure={fid} data-lead={f!.lead_before_start_h}>
                      <title>{`${m.label}, ${fid}: first alarm ${f!.first_alarm}, ${text} the window opened`}</title>
                      <rect x={LEFT} y={y - ROW / 2} width={plot + RIGHT} height={ROW} fill="transparent" />
                      <line x1={x(0)} x2={at} y1={y} y2={y} stroke={methodColor(m.key)} strokeWidth={2} strokeLinecap="round" />
                      <circle cx={at} cy={y} r={5} fill={methodColor(m.key)} className="lead-dot" />
                      <text x={labelRight ? at + 10 : at - 10} y={y + 4} textAnchor={labelRight ? "start" : "end"} className="value-text">
                        {text}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption>
        Each row is one method's first alarm for that failure. Left of the line the alarm came before the reported window opened; right of it, after. The same values are in the table below.
      </figcaption>
    </figure>
  );
}
