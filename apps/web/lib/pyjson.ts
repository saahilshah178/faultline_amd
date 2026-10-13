// The Python pipeline puts evidence into prompts with json.dumps(obj, ensure_ascii=False).
// To send the model the same bytes from TypeScript we cannot go through JSON.parse and
// JSON.stringify: that drops Python's ", " and ": " separators and turns 4.0 into 4.
// These helpers re-space the raw JSON text instead, keeping every number as written.

/** Re-space raw JSON text the way Python's json.dumps (default separators) writes it. */
export function pyCompact(raw: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += raw[++i] ?? "";
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === ",") {
      out += ", ";
    } else if (ch === ":") {
      out += ": ";
    } else if (ch !== " " && ch !== "\n" && ch !== "\r" && ch !== "\t") {
      out += ch;
    }
  }
  return out;
}

/** Raw text of each value of a top-level JSON object, keyed by property name. */
export function topLevelRaw(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  const n = text.length;
  const skipWs = () => {
    while (i < n && /\s/.test(text[i])) i++;
  };
  const readString = (): string => {
    const start = i;
    i++; // opening quote
    while (i < n && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++; // closing quote
    return text.slice(start, i);
  };
  const skipValue = () => {
    skipWs();
    const ch = text[i];
    if (ch === '"') {
      readString();
    } else if (ch === "{" || ch === "[") {
      let depth = 0;
      while (i < n) {
        const c = text[i];
        if (c === '"') {
          readString();
          continue;
        }
        if (c === "{" || c === "[") depth++;
        if (c === "}" || c === "]") depth--;
        i++;
        if (depth === 0) break;
      }
    } else {
      while (i < n && !/[\s,}\]]/.test(text[i])) i++;
    }
  };

  skipWs();
  if (text[i] !== "{") throw new SyntaxError("expected a JSON object");
  i++;
  for (;;) {
    skipWs();
    if (text[i] === "}" || i >= n) break;
    if (text[i] === ",") {
      i++;
      continue;
    }
    const key = JSON.parse(readString()) as string;
    skipWs();
    if (text[i] !== ":") throw new SyntaxError(`expected ':' after key ${key}`);
    i++;
    skipWs();
    const start = i;
    skipValue();
    out[key] = text.slice(start, i);
  }
  return out;
}

/** json.dumps(value, ensure_ascii=False) for a value that came from JSON.parse. */
export function pyDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(pyDumps).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${pyDumps(v)}`).join(", ")}}`;
  }
  return "null";
}
