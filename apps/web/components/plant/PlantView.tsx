"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type PanelBand, type PanelFrame, type PanelHandle, type PanelMarker, type PanelSeries, TimePanel } from "@/components/TimePanel";
import { RULE_LABEL, attribution, fmtPct, signalShort } from "@/lib/labels";
import { DayCache, buildFrame, lastValue } from "@/lib/replay";
import { INK, LOAD_COLOR, SCORE_COLOR, STATUS, signalColor } from "@/lib/theme";
import { DAY_S, fmtDuration, fmtShort, fmtWall, parseWall } from "@/lib/time";
import type { ReplayAlarm, ReplayManifest } from "@/lib/types";
import { Timeline, type TimelineHandle } from "./Timeline";

export interface AlarmInfo {
  top: string[];
  sustained: boolean;
}

interface Props {
  manifest: ReplayManifest;
  alarmInfo: Record<string, AlarmInfo>;
}

const SPEEDS = [
  { label: "10 min/s", value: 600 },
  { label: "1 h/s", value: 3600 },
  { label: "6 h/s", value: 21600 },
  { label: "1 day/s", value: 86400 },
];
const WINDOWS = [
  { label: "6 h", value: 6 * 3600 },
  { label: "24 h", value: DAY_S },
  { label: "3 d", value: 3 * DAY_S },
  { label: "7 d", value: 7 * DAY_S },
];
const DEFAULT_SIGNALS = ["TP2", "DV_pressure", "Reservoirs", "Oil_temperature", "Motor_current"];
const PRE_ROLL_S = 2 * 3600; // "jump to" lands this long before the failure's first sign
const PRIMARY = "faultline";
const SHORT_METHOD: Record<string, string> = {
  faultline: "Faultline",
  static_tuned: "Static, tuned",
  static_envelope: "Static, envelope",
};

interface Latest {
  clock: number;
  values: Record<string, number | null>;
  score: number | null;
  loaded: number | null;
  sampleAt: number | null;
}

function parseClockParam(raw: string | null): number | null {
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const t = parseWall(raw);
  return Number.isFinite(t) ? t : null;
}

export function PlantView({ manifest, alarmInfo }: Props) {
  const threshold = manifest.detector.threshold;
  const primaryAlarms = useMemo(() => manifest.alarms[PRIMARY] ?? [], [manifest]);

  // Where each "jump to" button lands: shortly before the failure's reported start,
  // or before Faultline's first alarm for it when that came earlier.
  const jumps = useMemo(
    () =>
      manifest.failures.map((f) => {
        const credited = primaryAlarms.filter((a) => a.attribution === f.id).map((a) => a.fire);
        const first = Math.min(f.start, ...credited);
        return { id: f.id, t: Math.max(manifest.start, first - PRE_ROLL_S) };
      }),
    [manifest, primaryAlarms],
  );

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(SPEEDS[1].value);
  const [windowS, setWindowS] = useState(WINDOWS[1].value);
  const [selected, setSelected] = useState<string[]>(DEFAULT_SIGNALS);
  const [overlays, setOverlays] = useState<Record<string, boolean>>({});
  const [latest, setLatest] = useState<Latest>({ clock: manifest.start, values: {}, score: null, loaded: null, sampleAt: null });
  const [buffering, setBuffering] = useState(false);
  const [loadNote, setLoadNote] = useState<{ pending: number; failed: string[] }>({ pending: 0, failed: [] });

  const clockRef = useRef(manifest.start);
  const playingRef = useRef(false);
  const speedRef = useRef(speed);
  const windowRef = useRef(windowS);
  const dirtyRef = useRef(true);
  const bufferingRef = useRef(false);
  const lastUiRef = useRef(-1e9);
  const pendingUiRef = useRef<{ latest: Latest; pending: number; failed: string[] } | null>(null);
  const cacheRef = useRef<DayCache | null>(null);
  const clockTextRef = useRef<HTMLSpanElement>(null);
  const clockBoxRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<TimelineHandle>(null);
  const panelRefs = useRef<Record<string, PanelHandle | null>>({});

  playingRef.current = playing;
  speedRef.current = speed;
  windowRef.current = windowS;

  // Signals grouped by unit: one panel per unit, never two units on one axis.
  const groups = useMemo(() => {
    const byUnit = new Map<string, { unit: string; keys: string[] }>();
    for (const s of manifest.signals) {
      if (!byUnit.has(s.unit)) byUnit.set(s.unit, { unit: s.unit, keys: [] });
      byUnit.get(s.unit)!.keys.push(s.key);
    }
    return [...byUnit.values()].map((g) => ({
      ...g,
      id: `signals-${g.unit}`,
      title: g.keys.length > 1 ? (g.unit === "bar" ? "Pressures" : `Signals in ${g.unit}`) : (manifest.signals.find((s) => s.key === g.keys[0])?.label ?? g.keys[0]),
    }));
  }, [manifest]);

  const methodRows = useMemo(
    () =>
      manifest.methods
        .filter((m) => m.key === PRIMARY || overlays[m.key])
        .map((m) => ({ key: m.key, label: SHORT_METHOD[m.key] ?? m.label })),
    [manifest, overlays],
  );

  const writeUrl = useCallback((t: number) => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("t", String(Math.round(t)));
      window.history.replaceState(null, "", url);
    } catch {
      // deep links are a convenience; ignore browsers that refuse
    }
  }, []);

  const seek = useCallback(
    (t: number) => {
      const clamped = Math.min(Math.max(t, manifest.start), manifest.end);
      clockRef.current = clamped;
      dirtyRef.current = true;
      lastUiRef.current = -1e9;
      writeUrl(clamped);
    },
    [manifest, writeUrl],
  );

  // Start-up: the clock comes from ?t=<epoch or "YYYY-MM-DDTHH:MM"> or defaults to just before the first failure.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = parseClockParam(params.get("t"));
    const start = fromUrl ?? jumps[0]?.t ?? manifest.start;
    clockRef.current = Math.min(Math.max(start, manifest.start), manifest.end);
    const wantSpeed = Number(params.get("speed"));
    if (SPEEDS.some((s) => s.value === wantSpeed)) setSpeed(wantSpeed);
    const wantWindow = Number(params.get("window"));
    if (WINDOWS.some((w) => w.value === wantWindow)) setWindowS(wantWindow);
    if (params.get("overlay")) {
      setOverlays(Object.fromEntries(params.get("overlay")!.split(",").map((k) => [k, true])));
    }
    if (params.get("play") === "1") setPlaying(true);
    cacheRef.current = new DayCache(manifest, () => {
      dirtyRef.current = true;
    });
    dirtyRef.current = true;
    setReady(true);
  }, [manifest, jumps]);

  // The replay loop. The clock and the charts are driven imperatively each frame;
  // React state (feed, readings) follows a few times a second.
  useEffect(() => {
    if (!ready) return;
    const cache = cacheRef.current!;
    let raf = 0;
    let last = performance.now();

    const render = (clock: number) => {
      const from = clock - windowRef.current;
      const frame = buildFrame(cache, manifest, from, clock);
      const bands: PanelBand[] = manifest.failures
        .filter((f) => f.start <= clock && f.end >= from)
        .map((f) => ({ from: f.start, to: f.end, color: "rgba(208, 59, 59, 0.16)", label: `${f.id} reported` }));
      const markers: PanelMarker[] = primaryAlarms
        .filter((a) => a.fire <= clock && a.fire >= from)
        .map((a) => ({ t: a.fire, color: STATUS.warning, label: a.id }));
      const base = { x: frame.x, xMin: from, xMax: clock, bands };
      for (const g of groups) {
        const panel = panelRefs.current[g.id];
        const next: PanelFrame = { ...base, ys: g.keys.map((k) => frame.signals[k]), markers: markers.map((m) => ({ ...m, label: undefined })) };
        panel?.update(next);
      }
      panelRefs.current.score?.update({ ...base, ys: [frame.score], markers });
      panelRefs.current.load?.update({ ...base, ys: [frame.loaded], markers: markers.map((m) => ({ ...m, label: undefined })) });

      if (clockTextRef.current) clockTextRef.current.textContent = fmtWall(clock);
      if (clockBoxRef.current) clockBoxRef.current.dataset.epoch = String(Math.floor(clock));
      timelineRef.current?.setClock(clock);

      // React state (feed, readings, timeline marks) follows at most a few times a second.
      // The snapshot is kept until it has been delivered, so the last one is never dropped.
      const values: Record<string, number | null> = {};
      const lastIndex = frame.x.length - 1;
      for (const s of manifest.signals) values[s.key] = lastIndex >= 0 ? frame.signals[s.key][lastIndex] : null;
      const scoreIndex = lastValue(frame.score);
      // Only treat the score as current if it is from the last few minutes.
      const scoreFresh = scoreIndex >= 0 && lastIndex - scoreIndex <= 5;
      pendingUiRef.current = {
        latest: {
          clock,
          values,
          score: scoreFresh ? frame.score[scoreIndex] : null,
          loaded: lastIndex >= 0 ? frame.loaded[lastIndex] : null,
          sampleAt: lastIndex >= 0 ? frame.x[lastIndex] : null,
        },
        pending: cache.pending(from, clock),
        failed: cache.failed(from, clock),
      };
    };

    const flushUi = (now: number) => {
      const next = pendingUiRef.current;
      if (!next || now - lastUiRef.current < 120) return;
      pendingUiRef.current = null;
      lastUiRef.current = now;
      setLatest(next.latest);
      setLoadNote((prev) => (prev.pending === next.pending && prev.failed.length === next.failed.length ? prev : { pending: next.pending, failed: next.failed }));
    };

    const tick = (now: number) => {
      const dt = Math.min(now - last, 250) / 1000;
      last = now;
      let clock = clockRef.current;
      const lookahead = playingRef.current ? Math.max(DAY_S, speedRef.current * 4) : 0;
      cache.ensureRange(clock - windowRef.current, Math.min(clock + lookahead, manifest.end));

      if (playingRef.current) {
        const want = Math.min(clock + speedRef.current * dt, manifest.end);
        // Hold the clock rather than run past data that has not arrived yet.
        const waiting = cache.pending(clock, want) > 0;
        if (waiting !== bufferingRef.current) {
          bufferingRef.current = waiting;
          setBuffering(waiting);
        }
        if (!waiting) clock = want;
        if (clock >= manifest.end) setPlaying(false);
      } else if (bufferingRef.current) {
        bufferingRef.current = false;
        setBuffering(false);
      }

      if (clock !== clockRef.current) {
        clockRef.current = clock;
        dirtyRef.current = true;
      }
      if (dirtyRef.current) {
        dirtyRef.current = false;
        render(clock);
      }
      flushUi(now);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready, manifest, groups, primaryAlarms]);

  // Redraw when a setting that changes the charts moves.
  useEffect(() => {
    dirtyRef.current = true;
    lastUiRef.current = -1e9;
  }, [windowS, selected, overlays]);

  const togglePlay = useCallback(() => {
    setPlaying((p) => {
      if (p) writeUrl(clockRef.current);
      else if (clockRef.current >= manifest.end) clockRef.current = manifest.start;
      return !p;
    });
  }, [manifest, writeUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.code !== "Space" || (target && /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(target.tagName))) return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay]);

  const clock = latest.clock;
  const active = primaryAlarms.filter((a) => a.fire <= clock && clock < a.end);
  const fired = useMemo(() => {
    const out: (ReplayAlarm & { method: string })[] = [];
    for (const row of methodRows) {
      for (const a of manifest.alarms[row.key] ?? []) if (a.fire <= clock) out.push({ ...a, method: row.key });
    }
    return out.sort((a, b) => b.fire - a.fire);
  }, [manifest, methodRows, clock]);
  const firedPrimary = fired.filter((a) => a.method === PRIMARY).length;

  const yScore = useCallback((_min: number | null, max: number | null): [number, number] => [0, Math.max((max ?? 0) * 1.1, threshold * 2)], [threshold]);
  const yLoad = useCallback((): [number, number] => [0, 1], []);
  const pctFormat = useCallback((v: number) => `${Math.round(v * 100)}%`, []);
  const scoreFormat = useCallback((v: number) => v.toFixed(2), []);

  const scoreSeries = useMemo<PanelSeries[]>(() => [{ key: "score", label: "Detector score", color: SCORE_COLOR, width: 1.5 }], []);
  const loadSeries = useMemo<PanelSeries[]>(
    () => [{ key: "loaded", label: "Under load", color: LOAD_COLOR, width: 1, fill: "rgba(109, 167, 236, 0.14)", stepped: true }],
    [],
  );

  const windowLabel = WINDOWS.find((w) => w.value === windowS)?.label ?? "";

  return (
    <div className="plant" data-ready={ready ? "1" : "0"}>
      <div className="panel controls" role="toolbar" aria-label="Replay controls">
        <button type="button" className="btn btn-primary play-btn" onClick={togglePlay} data-testid="play" aria-pressed={playing}>
          <span className={playing ? "icon-pause" : "icon-play"} aria-hidden />
          {playing ? "Pause" : "Play"}
        </button>
        {/* The clock text and data-epoch are written by the replay loop every frame, not by React. */}
        <div className="clock" ref={clockBoxRef} data-testid="clock">
          <span className="clock-label">Replay clock</span>
          <span className="clock-time" ref={clockTextRef} suppressHydrationWarning />
        </div>
        <fieldset className="seg" aria-label="Replay speed">
          <legend>Speed</legend>
          {SPEEDS.map((s) => (
            <button key={s.value} type="button" className={speed === s.value ? "is-on" : ""} onClick={() => setSpeed(s.value)} data-speed={s.value} aria-pressed={speed === s.value}>
              {s.label}
            </button>
          ))}
        </fieldset>
        <fieldset className="seg" aria-label="Chart window">
          <legend>Window</legend>
          {WINDOWS.map((w) => (
            <button key={w.value} type="button" className={windowS === w.value ? "is-on" : ""} onClick={() => setWindowS(w.value)} aria-pressed={windowS === w.value}>
              {w.label}
            </button>
          ))}
        </fieldset>
        <fieldset className="seg" aria-label="Jump to shortly before a reported failure">
          <legend>Jump to before</legend>
          {jumps.map((j) => (
            <button key={j.id} type="button" onClick={() => seek(j.t)} data-testid={`jump-${j.id}`} title={`Go to ${fmtShort(j.t)}, shortly before reported failure ${j.id}`}>
              {j.id}
            </button>
          ))}
        </fieldset>
        <div className="status-inline" aria-live="polite">
          {buffering ? <span className="chip chip-muted">loading data</span> : null}
          {loadNote.failed.length ? (
            <span className="chip chip-critical" title={loadNote.failed.join(", ")}>
              {loadNote.failed.length} day file{loadNote.failed.length > 1 ? "s" : ""} failed to load
            </span>
          ) : null}
        </div>
      </div>

      <div className="panel timeline-panel">
        <Timeline ref={timelineRef} manifest={manifest} rows={methodRows} firedBefore={clock} onSeek={seek} />
        <div className="timeline-legend">
          <span>
            <i className="key key-failure" /> reported failure window
          </span>
          <span>
            <i className="key key-alarm" /> Faultline alarm
          </span>
          {manifest.methods
            .filter((m) => m.key !== PRIMARY)
            .map((m) => (
              <label key={m.key} className="check">
                <input
                  type="checkbox"
                  checked={!!overlays[m.key]}
                  onChange={(e) => setOverlays((prev) => ({ ...prev, [m.key]: e.target.checked }))}
                  data-testid={`overlay-${m.key}`}
                />
                <i className="key key-static" /> compare: {m.label.toLowerCase()}
              </label>
            ))}
          <span className="timeline-hint">Alarms appear when the clock reaches them. Drag the strip to move the clock.</span>
        </div>
      </div>

      <div className="plant-grid">
        <div className="plant-charts">
          <div className="panel signal-picker" role="group" aria-label="Signals shown">
            <span className="picker-label">Signals</span>
            {manifest.signals.map((s) => {
              const on = selected.includes(s.key);
              return (
                <button
                  key={s.key}
                  type="button"
                  className={`sig-chip ${on ? "is-on" : ""}`}
                  aria-pressed={on}
                  title={`${s.label} (${s.unit})`}
                  onClick={() => setSelected((prev) => (on ? prev.filter((k) => k !== s.key) : [...prev, s.key]))}
                >
                  <i style={{ background: signalColor(s.key) }} />
                  {signalShort(s.key)}
                </button>
              );
            })}
            <span className="picker-note">
              last {windowLabel} up to the clock, {fmtDuration(manifest.step_s / 60)} means
            </span>
          </div>

          {groups.map((g) => {
            const series: PanelSeries[] = g.keys.map((k) => ({
              key: k,
              label: manifest.signals.find((s) => s.key === k)?.label ?? k,
              color: signalColor(k),
              show: selected.includes(k),
            }));
            const anyShown = series.some((s) => s.show);
            return (
              <div key={g.id} hidden={!anyShown}>
                <TimePanel
                  ref={(h) => {
                    panelRefs.current[g.id] = h;
                  }}
                  title={g.title}
                  unit={g.unit}
                  series={series}
                  height={g.keys.length > 1 ? 190 : 130}
                  syncKey="plant"
                  testId={`chart-${g.unit === "bar" ? "pressure" : g.keys[0]}`}
                />
              </div>
            );
          })}

          <TimePanel
            ref={(h) => {
              panelRefs.current.score = h;
            }}
            title="Detector score"
            unit="reconstruction error"
            note={`alarm when above ${threshold} for ${Math.round(manifest.detector.duration_s / 60)} min`}
            series={scoreSeries}
            height={140}
            syncKey="plant"
            yRange={yScore}
            format={scoreFormat}
            hline={{ value: threshold, label: `threshold ${threshold}`, color: STATUS.warning }}
            testId="chart-score"
          />
          <TimePanel
            ref={(h) => {
              panelRefs.current.load = h;
            }}
            title="Compressor under load"
            unit="share of each minute"
            series={loadSeries}
            height={110}
            syncKey="plant"
            yRange={yLoad}
            format={pctFormat}
            axisFormat={pctFormat}
            testId="chart-load"
          />
        </div>

        <aside className="plant-side">
          <section className={`panel state-tile ${active.length ? "is-alarm" : "is-normal"}`} data-testid="state">
            <span className="state-dot" aria-hidden />
            <div>
              <strong>{active.length ? `Alarm active: ${active.map((a) => a.id).join(", ")}` : "No active alarm"}</strong>
              <small>
                {active.length
                  ? `fired ${fmtShort(active[active.length - 1].fire)}`
                  : `${firedPrimary} Faultline alarm${firedPrimary === 1 ? "" : "s"} so far in this replay`}
              </small>
            </div>
          </section>

          <section className="panel readings">
            <h3>Now</h3>
            <div className="score-now">
              <span className="score-label">Detector score</span>
              <span className="score-value" data-testid="score-now">
                {latest.score === null ? "not scored" : latest.score.toFixed(3)}
              </span>
              <div className="meter" aria-hidden>
                <i
                  style={{
                    width: `${latest.score === null ? 0 : Math.min((latest.score / (threshold * 2)) * 100, 100)}%`,
                    background: latest.score !== null && latest.score > threshold ? STATUS.warning : INK.muted,
                  }}
                />
                <b style={{ left: "50%" }} />
              </div>
              <span className="score-sub">threshold {threshold}</span>
            </div>
            <table className="readings-table">
              <tbody>
                {manifest.signals.map((s) => (
                  <tr key={s.key}>
                    <th scope="row">
                      <i style={{ background: signalColor(s.key) }} />
                      {s.label}
                    </th>
                    <td>{latest.values[s.key] === null || latest.values[s.key] === undefined ? <em>not logging</em> : `${latest.values[s.key]!.toFixed(2)} ${s.unit}`}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row">
                    <i style={{ background: LOAD_COLOR }} />
                    Under load, last minute
                  </th>
                  <td>{latest.loaded === null ? <em>not logging</em> : fmtPct(latest.loaded)}</td>
                </tr>
              </tbody>
            </table>
            {loadNote.pending > 0 ? <p className="hint">Loading {loadNote.pending} day file{loadNote.pending > 1 ? "s" : ""} for this window.</p> : null}
          </section>

          <section className="panel feed" data-testid="feed">
            <header>
              <h3>Alarm feed</h3>
              <span className="count">{fired.length}</span>
            </header>
            {fired.length === 0 ? (
              <p className="empty">No alarm has fired yet at this point in the replay.</p>
            ) : (
              <ol>
                {fired.slice(0, 60).map((a) => {
                  const info = attribution(a.attribution);
                  const isActive = clock < a.end;
                  const detail = alarmInfo[a.id];
                  const body = (
                    <>
                      <div className="feed-top">
                        <span className={`feed-id ${a.method === PRIMARY ? "" : "is-static"}`}>{a.id}</span>
                        <time>{fmtShort(a.fire)}</time>
                        <span className={`chip ${isActive ? "chip-alarm" : "chip-muted"}`}>{isActive ? "active" : `cleared ${fmtShort(a.end)}`}</span>
                      </div>
                      <div className="feed-meta">
                        {a.method !== PRIMARY ? <span className="chip chip-outline">{SHORT_METHOD[a.method] ?? a.method}</span> : null}
                        <span className={`chip chip-attr-${info.kind}`} title={info.long}>
                          {info.short}
                        </span>
                        {detail?.sustained ? <span className="chip chip-outline" title="Fired while the compressor had been under load without a break">sustained load</span> : null}
                      </div>
                      <div className="feed-signals">
                        {a.method === PRIMARY
                          ? (detail?.top ?? []).map((k) => signalShort(k)).join(" · ")
                          : (a.rules ?? []).map((r) => RULE_LABEL[r] ?? r).join(" · ")}
                      </div>
                    </>
                  );
                  return (
                    <li key={`${a.method}-${a.id}`} data-testid="feed-item" data-alarm-id={a.id} data-method={a.method} className={isActive ? "is-active" : ""}>
                      {a.method === PRIMARY ? (
                        <Link href={`/alerts/${a.id}`} className="feed-link">
                          {body}
                        </Link>
                      ) : (
                        <div className="feed-link">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
            <p className="hint">Labels such as "false alarm" come from the benchmark, scored after the fact against the operator's failure reports.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
