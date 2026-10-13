import { DAY_S, dayKey, dayStart } from "./time";
import type { ReplayDay, ReplayManifest } from "./types";

export type DayStatus = "ready" | "loading" | "idle" | "absent" | "error";

/** Lazily fetched one-minute day files, keyed by date. */
export class DayCache {
  private readonly known: Set<string>;
  private readonly days = new Map<string, ReplayDay | "loading" | "error">();

  constructor(
    manifest: ReplayManifest,
    private readonly onChange: () => void,
    private readonly base = "/data/replay/days",
  ) {
    // Days missing from the manifest are days the unit logged nothing: a gap, not an error.
    this.known = new Set(manifest.days.map((d) => d.date));
  }

  status(date: string): DayStatus {
    if (!this.known.has(date)) return "absent";
    const day = this.days.get(date);
    if (day === undefined) return "idle";
    if (day === "loading" || day === "error") return day;
    return "ready";
  }

  get(date: string): ReplayDay | null {
    const day = this.days.get(date);
    return day && typeof day === "object" ? day : null;
  }

  ensure(date: string): void {
    if (!this.known.has(date) || this.days.has(date)) return;
    this.days.set(date, "loading");
    fetch(`${this.base}/${date}.json`)
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json() as Promise<ReplayDay>;
      })
      .then((day) => {
        this.days.set(date, day);
        this.onChange();
      })
      .catch(() => {
        this.days.set(date, "error");
        this.onChange();
      });
  }

  /** Start loading every day that overlaps [from, to]. */
  ensureRange(from: number, to: number): void {
    for (let t = dayStart(from); t <= to; t += DAY_S) this.ensure(dayKey(t));
  }

  pending(from: number, to: number): number {
    let n = 0;
    for (let t = dayStart(from); t <= to; t += DAY_S) {
      const s = this.status(dayKey(t));
      if (s === "loading" || s === "idle") n++;
    }
    return n;
  }

  failed(from: number, to: number): string[] {
    const out: string[] = [];
    for (let t = dayStart(from); t <= to; t += DAY_S) {
      if (this.status(dayKey(t)) === "error") out.push(dayKey(t));
    }
    return out;
  }
}

export interface ReplayFrame {
  x: number[];
  signals: Record<string, (number | null)[]>;
  loaded: (number | null)[];
  score: (number | null)[];
}

/**
 * One-minute samples from `from` up to the clock. A sample is the mean over the minute
 * that starts at its timestamp, so it is only included once that minute has fully passed:
 * nothing after the clock is ever shown. Minutes with no data stay null and plot as gaps.
 */
export function buildFrame(cache: DayCache, manifest: ReplayManifest, from: number, clock: number): ReplayFrame {
  const step = manifest.step_s;
  const first = Math.ceil(Math.max(from, manifest.start) / step) * step;
  const last = Math.floor(clock / step) * step - step;
  const n = last >= first ? Math.round((last - first) / step) + 1 : 0;
  const keys = manifest.signals.map((s) => s.key);
  const x = new Array<number>(n);
  const signals: Record<string, (number | null)[]> = {};
  for (const key of keys) signals[key] = new Array<number | null>(n).fill(null);
  const loaded = new Array<number | null>(n).fill(null);
  const score = new Array<number | null>(n).fill(null);

  for (let i = 0; i < n; ) {
    const t = first + i * step;
    const t0 = dayStart(t);
    const offset = Math.round((t - t0) / step);
    const perDay = Math.round(DAY_S / step);
    const count = Math.min(n - i, perDay - offset);
    const day = cache.get(dayKey(t0));
    for (let j = 0; j < count; j++) x[i + j] = t + j * step;
    if (day && day.step === step) {
      for (const key of keys) {
        const src = day.signals[key];
        const dst = signals[key];
        if (!src) continue;
        for (let j = 0; j < count; j++) dst[i + j] = src[offset + j] ?? null;
      }
      for (let j = 0; j < count; j++) {
        loaded[i + j] = day.loaded?.[offset + j] ?? null;
        score[i + j] = day.score?.[offset + j] ?? null;
      }
    }
    i += count;
  }
  return { x, signals, loaded, score };
}

/** Index of the last non-null value, or -1. */
export function lastValue(values: (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return i;
  return -1;
}
