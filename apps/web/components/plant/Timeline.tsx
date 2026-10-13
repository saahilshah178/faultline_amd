"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { attribution } from "@/lib/labels";
import { INK } from "@/lib/theme";
import { DAY_S, fmtShort, fmtWall, monthLabel, parseWall } from "@/lib/time";
import type { ReplayManifest } from "@/lib/types";

export interface TimelineHandle {
  setClock(t: number): void;
}

interface Props {
  manifest: ReplayManifest;
  rows: { key: string; label: string }[]; // alarm methods to show, Faultline first
  firedBefore: number; // only alarms with fire <= this are drawn
  onSeek: (t: number) => void;
}

const ROW_H = 9;
const ROW_GAP = 4;
const ROWS_TOP = 24;

// The whole record on one strip: logged coverage per day, the reported failure
// windows, and the alarms that have fired so far. Drag or click to move the clock.
export const Timeline = forwardRef<TimelineHandle, Props>(function Timeline({ manifest, rows, firedBefore, onSeek }, ref) {
  const trackRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const futureRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const span = manifest.end - manifest.start;
  const pct = (t: number) => `${(Math.min(Math.max((t - manifest.start) / span, 0), 1) * 100).toFixed(4)}%`;

  useImperativeHandle(ref, () => ({
    setClock(t: number) {
      const left = pct(t);
      if (headRef.current) headRef.current.style.left = left;
      if (futureRef.current) futureRef.current.style.left = left;
      if (trackRef.current) {
        trackRef.current.setAttribute("aria-valuenow", String(Math.round(t)));
        trackRef.current.setAttribute("aria-valuetext", fmtWall(t, false));
      }
    },
  }));

  const months = useMemo(() => {
    const out: { t: number; label: string }[] = [];
    const d = new Date(manifest.start * 1000);
    let cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    while (cursor <= manifest.end) {
      if (cursor >= manifest.start) out.push({ t: cursor, label: monthLabel(cursor) });
      const c = new Date(cursor * 1000);
      cursor = Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1, 1) / 1000;
    }
    return out;
  }, [manifest.start, manifest.end]);

  // Logged coverage per day. Days with little or no data read as dark gaps.
  useEffect(() => {
    const canvas = canvasRef.current;
    const track = trackRef.current;
    if (!canvas || !track) return;
    const draw = () => {
      const width = track.clientWidth;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(Math.round(width * ratio), 1);
      canvas.height = Math.round(10 * ratio);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const day of manifest.days) {
        const t0 = parseWall(`${day.date} 00:00:00`);
        const x0 = ((t0 - manifest.start) / span) * canvas.width;
        const x1 = ((t0 + DAY_S - manifest.start) / span) * canvas.width;
        ctx.fillStyle = INK.secondary;
        ctx.globalAlpha = 0.1 + 0.45 * Math.min(Math.max(day.coverage, 0), 1);
        ctx.fillRect(Math.floor(x0), 0, Math.max(Math.ceil(x1 - x0) - 1, 1), canvas.height);
      }
      ctx.globalAlpha = 1;
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(track);
    return () => observer.disconnect();
  }, [manifest, span]);

  const seekFromEvent = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const share = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    onSeek(manifest.start + share * span);
  };

  const height = ROWS_TOP + rows.length * (ROW_H + ROW_GAP) + 6;

  return (
    <div className="timeline" data-testid="timeline">
      <div className="timeline-gutter" style={{ height }} aria-hidden>
        <span style={{ top: 0 }}>Logged</span>
        {rows.map((row, i) => (
          <span key={row.key} style={{ top: ROWS_TOP + i * (ROW_H + ROW_GAP) - 3 }}>
            {row.label}
          </span>
        ))}
      </div>
      <div className="timeline-main">
        <div
          ref={trackRef}
          className="timeline-track"
          role="slider"
          tabIndex={0}
          aria-label="Replay position"
          aria-valuemin={manifest.start}
          aria-valuemax={manifest.end}
          style={{ height }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seekFromEvent(e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) seekFromEvent(e.clientX);
          }}
          onKeyDown={(e) => {
            const now = Number(e.currentTarget.getAttribute("aria-valuenow") ?? manifest.start);
            const stepS = e.shiftKey ? DAY_S : 3600;
            if (e.key === "ArrowLeft") onSeek(now - stepS);
            else if (e.key === "ArrowRight") onSeek(now + stepS);
            else return;
            e.preventDefault();
          }}
        >
          <canvas ref={canvasRef} className="timeline-coverage" aria-hidden />
          {months.map((m) => (
            <i key={m.t} className="timeline-tick" style={{ left: pct(m.t) }} />
          ))}
          {manifest.failures.map((f) => (
            <div
              key={f.id}
              className="timeline-failure"
              data-failure-id={f.id}
              style={{ left: pct(f.start), width: `max(3px, ${(((f.end - f.start) / span) * 100).toFixed(4)}%)` }}
              title={`Reported failure ${f.id}: ${fmtShort(f.start)} to ${fmtShort(f.end)}`}
            >
              <span>{f.id}</span>
            </div>
          ))}
          {rows.map((row, i) =>
            (manifest.alarms[row.key] ?? [])
              .filter((a) => a.fire <= firedBefore)
              .map((a) => (
                <i
                  key={`${row.key}-${a.id}`}
                  className={`timeline-alarm ${row.key === "faultline" ? "is-primary" : ""}`}
                  data-method={row.key}
                  data-alarm-id={a.id}
                  title={`${a.id} fired ${fmtShort(a.fire)} (${attribution(a.attribution).short})`}
                  style={{ left: pct(a.fire), top: ROWS_TOP + i * (ROW_H + ROW_GAP), height: ROW_H }}
                />
              )),
          )}
          <div ref={futureRef} className="timeline-future" />
          <div ref={headRef} className="timeline-head" />
        </div>
        <div className="timeline-months" aria-hidden>
          {months.map((m) => (
            <span key={m.t} style={{ left: pct(m.t) }}>
              {m.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
});
