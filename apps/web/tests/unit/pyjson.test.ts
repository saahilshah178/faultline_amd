import { describe, expect, it } from "vitest";
import { pyCompact, pyDumps, topLevelRaw } from "../../lib/pyjson";
import { fmtLead, fmtLeadLong } from "../../lib/labels";
import { fmtWall, parseWall } from "../../lib/time";

// What json.dumps(..., ensure_ascii=False) writes for the same values, typed out by hand.
const PRETTY = `{
 "alarm": {"id": "A001"},
 "evidence": {
  "unit": "°C",
  "mean": 4.0,
  "share": 1.0,
  "note": "a, b: \\"c\\" {d}",
  "normal_p05_p95": [
   -0.026,
   0.24
  ],
  "empty": [],
  "nothing": null
 },
 "explanation": null,
 "chat_examples": []
}`;

describe("pyjson", () => {
  it("slices top-level values without re-parsing them", () => {
    const raw = topLevelRaw(PRETTY);
    expect(Object.keys(raw)).toEqual(["alarm", "evidence", "explanation", "chat_examples"]);
    expect(raw.explanation).toBe("null");
    expect(raw.chat_examples).toBe("[]");
    expect(JSON.parse(raw.evidence).mean).toBe(4);
  });

  it("re-spaces JSON the way Python's json.dumps writes it, keeping number text", () => {
    const raw = topLevelRaw(PRETTY);
    expect(pyCompact(raw.evidence)).toBe(
      '{"unit": "°C", "mean": 4.0, "share": 1.0, "note": "a, b: \\"c\\" {d}", "normal_p05_p95": [-0.026, 0.24], "empty": [], "nothing": null}',
    );
  });

  it("serialises parsed values with Python's separators", () => {
    expect(pyDumps({ summary: "It's “hot”, 70 °C", citations: [{ doc: "doe-sourcebook", page: 33 }], ok: true, none: null })).toBe(
      '{"summary": "It\'s “hot”, 70 °C", "citations": [{"doc": "doe-sourcebook", "page": 33}], "ok": true, "none": null}',
    );
  });
});

describe("time and lead formatting", () => {
  it("treats the dataset's wall-clock strings as UTC, both ways", () => {
    expect(parseWall("2020-05-29 23:36:24")).toBe(1590795384);
    expect(fmtWall(1590795384)).toBe("2020-05-29 23:36:24");
  });

  it("spells out the direction of a lead time and never shows a miss as zero", () => {
    expect(fmtLead(-1.261)).toBe("76 min after");
    expect(fmtLead(1.682)).toBe("101 min before");
    expect(fmtLead(7.616)).toBe("7.6 h before");
    expect(fmtLead(null, false)).toBe("missed");
    expect(fmtLeadLong(-0.107)).toBe("6 min after the window opened");
    expect(fmtLeadLong(null, false)).toContain("missed");
  });
});
