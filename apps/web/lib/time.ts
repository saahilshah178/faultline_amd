// Time convention: every epoch value in the data is the dataset's zone-less
// wall-clock time encoded as UTC unix seconds. Format in UTC, always. Never use
// the viewer's time zone, or the UI would disagree with the strings in bench.json.

const pad = (n: number) => String(n).padStart(2, "0");

/** "2020-04-18 01:15:41" -> epoch seconds (treating the wall-clock time as UTC). */
export function parseWall(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)) / 1000;
}

/** epoch seconds -> "2020-04-18 01:15:41" */
export function fmtWall(epoch: number, withSeconds = true): string {
  const d = new Date(epoch * 1000);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return withSeconds ? `${date} ${time}:${pad(d.getUTCSeconds())}` : `${date} ${time}`;
}

export function fmtDate(epoch: number): string {
  return fmtWall(epoch).slice(0, 10);
}

export function fmtTime(epoch: number, withSeconds = false): string {
  return fmtWall(epoch, withSeconds).slice(11);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "18 Apr 01:15" */
export function fmtShort(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function monthLabel(epoch: number): string {
  return MONTHS[new Date(epoch * 1000).getUTCMonth()];
}

/** The same wall-clock string with seconds dropped: "2020-04-18 01:15". */
export function trimSeconds(wall: string): string {
  return wall.length >= 16 ? wall.slice(0, 16) : wall;
}

export const DAY_S = 86400;

/** Epoch of 00:00 on the day containing `epoch`. */
export function dayStart(epoch: number): number {
  return Math.floor(epoch / DAY_S) * DAY_S;
}

export function dayKey(epoch: number): string {
  return fmtDate(dayStart(epoch));
}

/** Minutes as "6 min", "6.5 h" or "3.1 d", for durations. */
export function fmtDuration(minutes: number): string {
  if (!Number.isFinite(minutes)) return "n/a";
  if (minutes < 1) return `${Math.round(minutes * 60)} s`;
  if (minutes < 120) return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(minutes < 10 ? 1 : 0)} min`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)} h`;
  return `${(minutes / 1440).toFixed(1)} d`;
}
