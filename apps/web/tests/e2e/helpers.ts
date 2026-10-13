import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP = path.resolve(HERE, "..", "..");
export const RESULTS = path.resolve(APP, "..", "..", "results");

export function readResult<T = any>(rel: string): T {
  return JSON.parse(readFileSync(path.join(RESULTS, rel), "utf8")) as T;
}

export function resultExists(rel: string): boolean {
  return existsSync(path.join(RESULTS, rel));
}

export function readFixture<T = any>(): T {
  return JSON.parse(readFileSync(path.join(APP, ".e2e", "fixture.json"), "utf8")) as T;
}

/** "2020-05-29 23:36:24" -> epoch seconds, wall-clock taken as UTC (the dataset's convention). */
export function wallToEpoch(s: string): number {
  const [date, time] = s.split(" ");
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi, se] = time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, se || 0) / 1000;
}

/** The benchmark's own rule for writing a lead time, re-stated independently of the app's code. */
export function expectedLead(hours: number | null, detected: boolean): RegExp {
  if (!detected || hours === null) return /missed/;
  const abs = Math.abs(hours);
  const magnitude = abs < 2 ? `${Math.round(abs * 60)} min` : `${abs.toFixed(1)} h`;
  return new RegExp(`^${magnitude.replace(".", "\\.")} ${hours > 0 ? "before" : "after"} the window opened`);
}
