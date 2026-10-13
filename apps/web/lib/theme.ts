// One dark theme. The same values are declared as CSS variables in app/globals.css;
// the canvas charts cannot read CSS variables cheaply, so they use these constants.

export const INK = {
  surface: "#1a1a19",
  plane: "#0d0d0d",
  primary: "#f0efec",
  secondary: "#c3c2b7",
  muted: "#898781",
  grid: "#2c2c2a",
  axis: "#383835",
} as const;

// Status colours: reserved for state, never used for a series.
export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;

// Categorical slots (dark steps), assigned in fixed order. Checked with the
// dataviz palette validator against the #1a1a19 surface.
const SLOTS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9"] as const;

// Colour follows the signal everywhere it appears.
export const SIGNAL_COLOR: Record<string, string> = {
  TP2: SLOTS[0],
  TP3: SLOTS[1],
  H1: SLOTS[2],
  DV_pressure: SLOTS[3],
  Reservoirs: SLOTS[4],
  Oil_temperature: SLOTS[5],
  Motor_current: SLOTS[6],
};

export function signalColor(key: string): string {
  return SIGNAL_COLOR[key] ?? INK.secondary;
}

// The three alarm methods, compared side by side (first three slots: distinct in every pairing).
export const METHOD_COLOR: Record<string, string> = {
  faultline: SLOTS[0],
  static_tuned: SLOTS[1],
  static_envelope: SLOTS[2],
};

export function methodColor(key: string): string {
  return METHOD_COLOR[key] ?? INK.secondary;
}

export const SCORE_COLOR = INK.primary;
export const LOAD_COLOR = "#6da7ec";
