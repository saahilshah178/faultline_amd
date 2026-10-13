"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { INK } from "@/lib/theme";
import { fmtWall } from "@/lib/time";

// One time-series panel on a single y-axis, drawn on canvas with uPlot. Panels with
// different units are separate panels, never a second axis. Nulls are drawn as gaps.

export interface PanelSeries {
  key: string;
  label: string;
  color: string;
  width?: number;
  fill?: string;
  show?: boolean;
  stepped?: boolean;
}

export interface PanelMarker {
  t: number;
  color: string;
  label?: string;
  dashed?: boolean;
}

export interface PanelBand {
  from: number;
  to: number;
  color: string;
  label?: string;
}

export interface PanelFrame {
  x: number[];
  ys: (number | null)[][];
  xMin: number;
  xMax: number;
  markers?: PanelMarker[];
  bands?: PanelBand[];
}

export interface PanelHandle {
  update(frame: PanelFrame): void;
}

interface Props {
  title: string;
  unit: string;
  note?: string;
  series: PanelSeries[];
  height?: number;
  syncKey?: string;
  /** Maps the data extent to the axis extent. Receives nulls when the window holds no data. */
  yRange?: (min: number | null, max: number | null) => [number, number];
  hline?: { value: number; label: string; color: string };
  /** Formats values in the cursor readout. */
  format?: (v: number) => string;
  /** Formats y-axis ticks; defaults to the plain number. */
  axisFormat?: (v: number) => string;
  frame?: PanelFrame;
  testId?: string;
}

const EMPTY: PanelFrame = { x: [], ys: [], xMin: 0, xMax: 1 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

function tickLabel(ts: number): string {
  const d = new Date(ts * 1000); // data times are wall-clock times stored as UTC
  if (ts % 86400 === 0) return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

const defaultRange = (min: number | null, max: number | null): [number, number] => {
  if (min === null || max === null) return [0, 1];
  const padding = (max - min) * 0.08 || Math.abs(max) * 0.08 || 1;
  return [min - padding, max + padding];
};

export const TimePanel = forwardRef<PanelHandle, Props>(function TimePanel(
  { title, unit, note, series, height = 150, syncKey, yRange = defaultRange, hline, format, axisFormat, frame, testId },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const frameRef = useRef<PanelFrame>(frame ?? EMPTY);
  const yRangeRef = useRef(yRange);
  yRangeRef.current = yRange;
  const hlineRef = useRef(hline);
  hlineRef.current = hline;

  const apply = (next: PanelFrame) => {
    frameRef.current = next;
    const u = plotRef.current;
    if (!u) return;
    u.setData([next.x, ...next.ys] as uPlot.AlignedData);
    u.root.dataset.points = String(next.x.length);
  };

  useImperativeHandle(ref, () => ({ update: apply }));

  // Series identity (not visibility) decides when the plot is rebuilt.
  const specKey = series.map((s) => `${s.key}:${s.color}:${s.width ?? ""}:${s.fill ?? ""}`).join("|");

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const css = getComputedStyle(el);
    const mono = css.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace";
    const font = `11px ${mono}`;
    const fmt = format ?? ((v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)));
    const dpr = () => uPlot.pxRatio;
    // Units that are a symbol go after the value; descriptive ones ("share of each minute") do not.
    const valueUnit = unit.length <= 3 ? unit : "";

    const drawBands = (u: uPlot) => {
      const bands = frameRef.current.bands ?? [];
      if (!bands.length) return;
      const { ctx, bbox } = u;
      ctx.save();
      ctx.beginPath();
      ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
      ctx.clip();
      for (const band of bands) {
        const x0 = Math.max(bbox.left, u.valToPos(band.from, "x", true));
        const x1 = Math.min(bbox.left + bbox.width, u.valToPos(band.to, "x", true));
        if (x1 <= x0) continue;
        ctx.fillStyle = band.color;
        ctx.fillRect(x0, bbox.top, Math.max(x1 - x0, dpr()), bbox.height);
        if (band.label) {
          ctx.fillStyle = INK.secondary;
          ctx.font = `${10 * dpr()}px ${mono}`;
          ctx.textBaseline = "bottom";
          ctx.textAlign = "left";
          ctx.fillText(band.label, x0 + 4 * dpr(), bbox.top + bbox.height - 3 * dpr());
        }
      }
      ctx.restore();
    };

    const drawOverlay = (u: uPlot) => {
      const { ctx, bbox } = u;
      const line = hlineRef.current;
      ctx.save();
      if (line) {
        const y = u.valToPos(line.value, "y", true);
        if (y >= bbox.top && y <= bbox.top + bbox.height) {
          ctx.strokeStyle = line.color;
          ctx.lineWidth = dpr();
          ctx.setLineDash([6 * dpr(), 4 * dpr()]);
          ctx.beginPath();
          ctx.moveTo(bbox.left, y);
          ctx.lineTo(bbox.left + bbox.width, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = INK.secondary;
          ctx.font = `${10 * dpr()}px ${mono}`;
          ctx.textAlign = "left";
          ctx.textBaseline = "bottom";
          ctx.fillText(line.label, bbox.left + 4 * dpr(), y - 3 * dpr());
        }
      }
      let labelRow = 0;
      for (const marker of frameRef.current.markers ?? []) {
        const x = u.valToPos(marker.t, "x", true);
        if (x < bbox.left || x > bbox.left + bbox.width) continue;
        ctx.strokeStyle = marker.color;
        ctx.lineWidth = 1.5 * dpr();
        ctx.setLineDash(marker.dashed ? [4 * dpr(), 3 * dpr()] : []);
        ctx.beginPath();
        ctx.moveTo(x, bbox.top);
        ctx.lineTo(x, bbox.top + bbox.height);
        ctx.stroke();
        ctx.setLineDash([]);
        if (marker.label) {
          ctx.font = `${10 * dpr()}px ${mono}`;
          const w = ctx.measureText(marker.label).width + 8 * dpr();
          const flip = x + w > bbox.left + bbox.width;
          const top = bbox.top + 2 * dpr() + (labelRow % 2) * 15 * dpr();
          labelRow++;
          ctx.fillStyle = INK.surface;
          ctx.fillRect(flip ? x - w : x, top, w, 13 * dpr());
          ctx.fillStyle = INK.primary;
          ctx.textAlign = "left";
          ctx.textBaseline = "top";
          ctx.fillText(marker.label, (flip ? x - w : x) + 4 * dpr(), top + 1.5 * dpr());
        }
      }
      ctx.restore();
    };

    const axis = (extra: Partial<uPlot.Axis>): uPlot.Axis => ({
      stroke: INK.muted,
      font,
      grid: { stroke: INK.grid, width: 1 },
      ticks: { stroke: INK.axis, width: 1, size: 4 },
      ...extra,
    });

    const options: uPlot.Options = {
      width: Math.max(el.clientWidth, 120),
      height,
      // Format every time in UTC: the data's times are wall-clock times stored as UTC.
      tzDate: (ts) => uPlot.tzDate(new Date(ts * 1000), "UTC"),
      padding: [10, 20, 0, 0],
      cursor: {
        sync: syncKey ? { key: syncKey } : undefined,
        drag: { x: false, y: false },
        points: { size: 7 },
      },
      legend: { show: true, live: true },
      scales: {
        x: { time: true, range: () => [frameRef.current.xMin, frameRef.current.xMax] },
        y: { range: (_u, min, max) => yRangeRef.current(min ?? null, max ?? null) },
      },
      axes: [
        axis({ values: (_u, splits) => splits.map(tickLabel), space: 70, size: 26 }),
        axis({ size: 52, values: (_u, splits) => splits.map((v) => (axisFormat ? axisFormat(v) : String(+v.toFixed(2)))) }),
      ],
      series: [
        { label: "Cursor", value: (_u, ts) => (ts === null || ts === undefined ? "move over the chart to read values" : fmtWall(ts)) },
        ...series.map(
          (s): uPlot.Series => ({
            label: s.label,
            stroke: s.color,
            width: s.width ?? 1.5,
            fill: s.fill,
            show: s.show ?? true,
            spanGaps: false,
            points: { show: false },
            paths: s.stepped ? uPlot.paths.stepped?.({ align: 1 }) : undefined,
            value: (_u, v, _si, idx) => (idx === null || idx === undefined ? "" : v === null || v === undefined ? "no data" : `${fmt(v)} ${valueUnit}`),
          }),
        ),
      ],
      hooks: { drawAxes: [drawBands], draw: [drawOverlay] },
    };

    const current = frameRef.current;
    const u = new uPlot(options, [current.x, ...(current.ys.length ? current.ys : series.map(() => []))] as uPlot.AlignedData, el);
    plotRef.current = u;
    u.root.dataset.points = String(current.x.length);

    const observer = new ResizeObserver(() => {
      const width = el.clientWidth;
      if (width > 0 && Math.abs(width - u.width) > 1) u.setSize({ width, height });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      u.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, height, syncKey, unit]);

  useEffect(() => {
    const u = plotRef.current;
    if (!u) return;
    series.forEach((s, i) => {
      const show = s.show ?? true;
      if (u.series[i + 1] && u.series[i + 1].show !== show) u.setSeries(i + 1, { show });
    });
  });

  useEffect(() => {
    if (frame) apply(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame]);

  return (
    <section className="panel chart-panel" data-testid={testId}>
      <header className="chart-head">
        <h3>{title}</h3>
        <span className="chart-unit">{unit}</span>
        {note ? <span className="chart-note">{note}</span> : null}
      </header>
      <div ref={rootRef} className="chart-root" />
    </section>
  );
});
