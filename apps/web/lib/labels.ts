// Wording for values that come from the pipeline. No number is written here:
// every figure is formatted from a value passed in.

export type AttributionKind = "failure" | "buffer" | "tuning" | "false" | "other";

export interface AttributionInfo {
  kind: AttributionKind;
  failure?: string;
  short: string;
  long: string;
}

export function attribution(a: string): AttributionInfo {
  if (/^F\d+$/.test(a)) {
    return { kind: "failure", failure: a, short: `Failure ${a}`, long: `Credited to reported failure ${a}` };
  }
  if (a.startsWith("buffer:")) {
    const f = a.slice("buffer:".length);
    return { kind: "buffer", failure: f, short: `After ${f}`, long: `In the buffer after failure ${f}: counted neither as a detection nor as a false alarm` };
  }
  if (a === "tuning_period") {
    return { kind: "tuning", short: "Tuning period", long: "Fired in the pre-failure period used to tune the detector: not scored" };
  }
  if (a === "false_alarm") {
    return { kind: "false", short: "False alarm", long: "No reported failure nearby: counted as a false alarm" };
  }
  return { kind: "other", short: a, long: a };
}

/** "76 min" below two hours, "7.6 h" above, like results/bench.md. */
export function fmtLeadMagnitude(hours: number): string {
  const abs = Math.abs(hours);
  return abs < 2 ? `${Math.round(abs * 60)} min` : `${abs.toFixed(1)} h`;
}

/**
 * lead_before_start_h is positive when the alarm came BEFORE the reported window
 * start and negative when it came after. Spell the direction out every time.
 */
export function fmtLead(hours: number | null | undefined, detected = true): string {
  if (!detected || hours === null || hours === undefined) return "missed";
  if (hours === 0) return "at the window start";
  return `${fmtLeadMagnitude(hours)} ${hours > 0 ? "before" : "after"}`;
}

export function fmtLeadLong(hours: number | null | undefined, detected = true): string {
  if (!detected || hours === null || hours === undefined) return "missed: no alarm for this failure";
  if (hours === 0) return "at the moment the window opened";
  return `${fmtLeadMagnitude(hours)} ${hours > 0 ? "before the window opened" : "after the window opened"}`;
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return v.toFixed(digits);
}

export function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return Math.round(v).toLocaleString("en-US");
}

export function fmtPct(share: number | null | undefined, digits = 0): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return "n/a";
  return `${(share * 100).toFixed(digits)}%`;
}

export function fmtSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return "n/a";
  if (s % 3600 === 0 && s >= 3600) return `${s / 3600} h`;
  if (s % 60 === 0 && s >= 60) return `${s / 60} min`;
  return `${s} s`;
}

export const SIGNAL_SHORT: Record<string, string> = {
  TP2: "TP2",
  TP3: "TP3",
  H1: "H1",
  DV_pressure: "DV pressure",
  Reservoirs: "Reservoirs",
  Oil_temperature: "Oil temp",
  Motor_current: "Motor current",
};

export function signalShort(key: string): string {
  return SIGNAL_SHORT[key] ?? key.replaceAll("_", " ");
}

// Names follow docs/apu_description.md, section 4.
export const DIGITAL_LABEL: Record<string, string> = {
  COMP: "Intake valve signal (COMP)",
  DV_eletric: "Outlet valve control (DV electric)",
  Towers: "Dryer tower selector (Towers)",
  MPG: "Start-under-load signal (MPG)",
  LPS: "Low pressure switch (LPS)",
  Pressure_switch: "Tower discharge pressure switch",
  Oil_level: "Oil level switch",
  Caudal_impulses: "Flow meter pulses (Caudal impulses)",
};

export const RULE_LABEL: Record<string, string> = {
  oil_temperature: "Oil temperature high",
  motor_current: "Motor current high",
  pressure_drop_rate: "Reservoir pressure falling fast",
};

export function sourceLink(source: { url: string; doc: string } | undefined, page: number): string | null {
  if (!source) return null;
  // For the DOE sourcebook `page` is the PDF page, so the link can open it directly.
  // For the unit description `page` is a section number of one markdown file.
  return source.doc === "doe-sourcebook" ? `${source.url}#page=${page}` : source.url;
}

export function pageLabel(source: { page_label?: string } | undefined, page: number): string {
  return `${source?.page_label ?? "page"} ${page}`;
}
