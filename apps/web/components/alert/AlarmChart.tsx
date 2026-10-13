"use client";

import { useEffect, useMemo, useState } from "react";
import { type PanelFrame, type PanelMarker, type PanelSeries, TimePanel } from "@/components/TimePanel";
import { fmtPct, signalShort } from "@/lib/labels";
import { INK, SCORE_COLOR, STATUS, signalColor } from "@/lib/theme";
import { fmtDuration, fmtTime } from "@/lib/time";
import type { AlarmWindow, ReplaySignal, TopSignal } from "@/lib/types";

interface Props {
  alarmId: string;
  signals: ReplaySignal[];
  topSignals: TopSignal[];
}

const EMPHASISED = 3;

/** Rows with a null inserted wherever the unit stopped logging, so the gap is drawn as a gap. */
function withGaps(win: AlarmWindow) {
  const dts: number[] = [];
  for (let i = 1; i < win.t.length; i++) dts.push(win.t[i] - win.t[i - 1]);
  const typical = [...dts].sort((a, b) => a - b)[Math.floor(dts.length / 2)] ?? 10;
  const limit = typical * 3;
  const x: number[] = [];
  const keep: (number | null)[] = []; // index into the source arrays, or null for an inserted gap
  for (let i = 0; i < win.t.length; i++) {
    if (i > 0 && win.t[i] - win.t[i - 1] > limit) {
      x.push(win.t[i - 1] + typical);
      keep.push(null);
    }
    x.push(win.t[i]);
    keep.push(i);
  }
  const pick = (values: (number | null)[] | undefined) => keep.map((i) => (i === null ? null : (values?.[i] ?? null)));
  return { x, pick, typical, gaps: keep.filter((i) => i === null).length };
}

export function AlarmChart({ alarmId, signals, topSignals }: Props) {
  const [win, setWin] = useState<AlarmWindow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setWin(null);
    setError(null);
    fetch(`/data/replay/alarms/${alarmId}.json`)
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json() as Promise<AlarmWindow>;
      })
      .then((data) => {
        if (!cancelled) setWin(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [alarmId]);

  const emphasised = useMemo(() => new Set(topSignals.slice(0, EMPHASISED).map((s) => s.signal)), [topSignals]);

  const view = useMemo(() => {
    if (!win || win.t.length === 0) return null;
    const { x, pick, gaps, typical } = withGaps(win);
    const xMin = win.t[0];
    const xMax = win.t[win.t.length - 1];
    const markers: PanelMarker[] = [
      { t: win.onset, color: INK.secondary, label: `anomaly began ${fmtTime(win.onset)}`, dashed: true },
      { t: win.fire, color: STATUS.warning, label: `alarm fired ${fmtTime(win.fire)}` },
    ];
    if (win.end > xMin && win.end < xMax) markers.push({ t: win.end, color: INK.muted, label: `cleared ${fmtTime(win.end)}`, dashed: true });
    const plain = markers.map((m) => ({ ...m, label: undefined }));

    const byUnit = new Map<string, ReplaySignal[]>();
    for (const s of signals) {
      if (!win.signals[s.key]) continue;
      if (!byUnit.has(s.unit)) byUnit.set(s.unit, []);
      byUnit.get(s.unit)!.push(s);
    }
    // Top contributors are drawn heavier. Where several signals share a panel the others
    // are also faded; a signal alone in its panel keeps its full colour so it stays readable.
    const style = (key: string, label: string, alone = false): PanelSeries => {
      const strong = emphasised.has(key);
      return { key, label: strong ? `${label} (top contributor)` : label, color: strong || alone ? signalColor(key) : `${signalColor(key)}b3`, width: strong ? 2.25 : 1.25 };
    };
    const groups = [...byUnit.entries()].map(([unit, list]) => ({
      unit,
      title: list.length > 1 ? (unit === "bar" ? "Pressures" : `Signals in ${unit}`) : list[0].label,
      series: list.map((s) => style(s.key, s.label, list.length === 1)),
      frame: { x, xMin, xMax, ys: list.map((s) => pick(win.signals[s.key])), markers: plain } satisfies PanelFrame,
    }));
    const errorKeys = signals.filter((s) => win.errors?.[s.key]);
    return {
      gaps,
      groups,
      score: { x, xMin, xMax, ys: [pick(win.score)], markers } satisfies PanelFrame,
      errors: {
        series: errorKeys.map((s) => style(s.key, signalShort(s.key))),
        frame: { x, xMin, xMax, ys: errorKeys.map((s) => pick(win.errors[s.key])), markers: plain } satisfies PanelFrame,
      },
      threshold: win.threshold,
      // Described from the file itself: sampling interval and how far the window reaches either side of the alarm.
      note: `${typical} s samples, from ${fmtDuration((win.fire - xMin) / 60)} before the alarm to ${fmtDuration((xMax - win.fire) / 60)} after`,
    };
  }, [win, signals, emphasised]);

  const scoreSeries = useMemo<PanelSeries[]>(() => [{ key: "score", label: "Detector score", color: SCORE_COLOR, width: 1.5 }], []);

  return (
    <section className="alarm-chart" data-testid="alarm-chart" data-state={error ? "error" : view ? "ready" : "loading"}>
      {error ? (
        <div className="panel empty-state">
          <h2>The alarm window could not be loaded</h2>
          <p>
            <code>results/replay/alarms/{alarmId}.json</code> did not load ({error}). It is written by <code>python -m faultline.export_replay</code>.
          </p>
        </div>
      ) : !view ? (
        <div className="panel chart-placeholder">Loading the alarm window</div>
      ) : (
        <>
          <TimePanel
            title="Detector score"
            unit="reconstruction error"
            note={view.note}
            series={scoreSeries}
            height={150}
            syncKey={`alarm-${alarmId}`}
            yRange={(_min, max) => [0, Math.max((max ?? 0) * 1.1, view.threshold * 2)]}
            hline={{ value: view.threshold, label: `threshold ${view.threshold}`, color: STATUS.warning }}
            frame={view.score}
            testId="alarm-chart-score"
          />
          {view.groups.map((g) => (
            <TimePanel
              key={g.unit}
              title={g.title}
              unit={g.unit}
              series={g.series}
              height={g.series.length > 1 ? 200 : 130}
              syncKey={`alarm-${alarmId}`}
              frame={g.frame}
              testId={`alarm-chart-${g.unit === "bar" ? "pressure" : g.series[0].key}`}
            />
          ))}
          {view.errors.series.length ? (
            <TimePanel
              title="Reconstruction error by signal"
              unit="error"
              note="what the detector could not reproduce, per signal"
              series={view.errors.series}
              height={170}
              syncKey={`alarm-${alarmId}`}
              yRange={(_min, max) => [0, (max ?? 1) * 1.08 || 1]}
              frame={view.errors.frame}
              testId="alarm-chart-errors"
            />
          ) : null}
          {view.gaps > 0 ? (
            <p className="hint">
              The unit stopped logging {view.gaps} time{view.gaps > 1 ? "s" : ""} in this window. Those stretches are left blank, not joined up.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Each signal's share of the detector's reconstruction error when the alarm fired. */
export function ErrorShares({ signals, topSignals }: { signals: ReplaySignal[]; topSignals: TopSignal[] }) {
  const maxShare = Math.max(...topSignals.map((s) => s.share), 0.0001);
  if (topSignals.length === 0) return null;
  return (
    <section className="panel share-panel" data-testid="error-shares">
      <h2>Share of the detector's error at the alarm</h2>
      <p className="hint">Which signals the detector could not reproduce. The top {Math.min(EMPHASISED, topSignals.length)} are drawn heavier in the charts.</p>
      <ol className="share-list">
        {topSignals.map((s, i) => (
          <li key={s.signal} className={i < EMPHASISED ? "is-top" : ""} data-signal={s.signal}>
            <span className="share-name">
              <i style={{ background: signalColor(s.signal) }} />
              {signals.find((x) => x.key === s.signal)?.label ?? s.signal}
            </span>
            <span className="share-value" data-value={s.share}>
              {fmtPct(s.share, 1)}
            </span>
            <span className="share-bar">
              <i style={{ width: `${(s.share / maxShare) * 100}%`, background: signalColor(s.signal), opacity: i < EMPHASISED ? 1 : 0.5 }} />
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
