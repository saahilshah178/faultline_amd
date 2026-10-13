// The same cases as tests/test_explain.py at the repo root, run against the TypeScript
// port, so the two implementations of citation validation and retrieval agree.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ChatMessage,
  type ChatResult,
  type Chunk,
  type Embedder,
  type LLM,
  MAX_ATTEMPTS,
  QUERY_INSTRUCTION,
  Retriever,
  StillInvalidError,
  chatProblems,
  citationProblems,
  explanationProblems,
  extractJson,
  formatExcerpts,
  generateValidated,
  normalize,
  queryText,
  retrievalQueries,
} from "../../lib/explain-core";
import type { Evidence, Excerpt, LlmCall } from "../../lib/types";

// The real schema file the Python pipeline uses, not a copy.
const SCHEMA = JSON.parse(readFileSync(path.resolve(__dirname, "../../../../prompts/schemas/explanation.schema.json"), "utf8")) as object;

const EXCERPTS: Excerpt[] = [
  {
    id: "doe-p033-c1",
    doc: "doe-sourcebook",
    page: 33,
    printed_page: 28,
    text:
      "Leaks can be a significant source of wasted energy in an industrial compressed air " +
      "system, sometimes wasting 20 to 30 percent of a compressor\u2019s output. Leaks cause " +
      "a drop in system pressure, which can make air tools function less efficiently.",
  },
  {
    id: "apu-s02-c1",
    doc: "apu-description",
    page: 2,
    printed_page: null,
    text:
      "How the unit cycles. The compressor does not run continuously. A pressure switch " +
      "signal (MPG) starts the compressor under load when the pressure in the unit falls below 8.2 bar.",
  },
];

const GOOD = {
  summary: "The compressor has stopped cycling and is running under load without a break.",
  likely_causes: [
    { cause: "Air leak downstream of the compressor", evidence: "under load 100% of the last 30 minutes; normal is 7%", confidence: "medium" },
  ],
  recommended_actions: [
    { action: "Walk the pneumatic circuit and listen for leaks", why: "locates the loss", urgency: "now" },
    { action: "Check the dryer drain valve", why: "a stuck drain vents air", urgency: "this_shift" },
  ],
  citations: [
    { doc: "doe-sourcebook", page: 33, quote: "Leaks cause a drop in system pressure, which can make air tools function less efficiently" },
    { doc: "apu-description", page: 2, quote: "starts the compressor under load when the pressure in the unit falls below 8.2 bar" },
  ],
};

const withCitations = (...citations: object[]) => ({ ...GOOD, citations });

describe("citation validation", () => {
  it("valid explanation passes", () => {
    expect(explanationProblems(GOOD, EXCERPTS, SCHEMA)).toEqual([]);
  });

  it("quote matching ignores case, whitespace and curly quotes", () => {
    const cite = { doc: "doe-sourcebook", page: 33, quote: "  sometimes wasting 20 to 30 percent of a\n compressor's OUTPUT. " };
    expect(citationProblems([cite], EXCERPTS)).toEqual([]);
  });

  it("quote matching tolerates words broken by the PDF", () => {
    const excerpt = [{ ...EXCERPTS[0], text: "A typical plant will likely have a leak rate equal to 20 percent of total com- pressed air production capacity." }];
    const cite = { doc: "doe-sourcebook", page: 33, quote: "a leak rate equal to 20 percent of total compressed air production capacity" };
    expect(citationProblems([cite], excerpt)).toEqual([]);
    expect(normalize("total com- pressed air")).toBe("total compressed air");
    expect(normalize("a - b, non-breaking")).toBe("a - b, non-breaking");
  });

  it("fabricated quote is rejected", () => {
    const cite = { doc: "doe-sourcebook", page: 33, quote: "Leaks always indicate a failed discharge valve that must be replaced immediately" };
    const problems = citationProblems([cite], EXCERPTS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("does not appear word for word");
  });

  it("right quote on the wrong page is rejected", () => {
    const cite = { ...GOOD.citations[0], page: 34 };
    const problems = citationProblems([cite], EXCERPTS);
    expect(problems.some((p) => p.includes("not one of the excerpts"))).toBe(true);
  });

  it("paraphrase and short quotes are rejected", () => {
    const short = { doc: "doe-sourcebook", page: 33, quote: "Leaks cause a drop" };
    expect(citationProblems([short], EXCERPTS).some((p) => p.includes("too short"))).toBe(true);
  });

  it("at least one manual citation is required", () => {
    const problems = explanationProblems(withCitations(GOOD.citations[1], GOOD.citations[1]), EXCERPTS, SCHEMA);
    expect(problems).toEqual(["at least one citation must come from doc doe-sourcebook"]);
  });

  it("schema violations are reported", () => {
    const bad = { ...GOOD, likely_causes: [{ cause: "x", evidence: "y", confidence: "certain" }] };
    expect(explanationProblems(bad, EXCERPTS, SCHEMA)[0].startsWith("schema:")).toBe(true);
    const { citations: _dropped, ...withoutCitations } = GOOD;
    expect(explanationProblems(withoutCitations, EXCERPTS, SCHEMA)[0].startsWith("schema:")).toBe(true);
  });

  it("chat citations must point at retrieved pages", () => {
    const ok = "Check the drain valve first [doe-sourcebook p.33]. The unit starts loading below 8.2 bar [apu-description p.2].";
    expect(chatProblems(ok, EXCERPTS)).toEqual([]);
    const bad = "Replace the separator [doe-sourcebook p.71].";
    expect(chatProblems(bad, EXCERPTS)[0]).toContain("[doe-sourcebook p.71]");
  });

  it("the rejection messages are the ones the Python validator writes", () => {
    expect(citationProblems([{ doc: "doe-sourcebook", page: 34, quote: "x" }], EXCERPTS)).toEqual([
      "citation 1: doe-sourcebook page 34 is not one of the excerpts you were given",
    ]);
    expect(citationProblems([{ doc: "doe-sourcebook", page: 33, quote: "Leaks cause a drop" }], EXCERPTS)).toEqual([
      "citation 1: the quote is too short; copy at least 8 consecutive words",
    ]);
    expect(citationProblems([{ doc: "doe-sourcebook", page: 33, quote: "one two three four five six seven eight" }], EXCERPTS)).toEqual([
      "citation 1: the quote does not appear word for word in an excerpt from doe-sourcebook page 33; copy one contiguous passage exactly",
    ]);
    expect(chatProblems("a [doe-sourcebook p.71] b [apu-description p. 9] c [doe-sourcebook p.71]", EXCERPTS)).toEqual([
      "these citations are not among the excerpts: [apu-description p.9], [doe-sourcebook p.71]",
    ]);
  });

  it("normalize matches the Python normalisation", () => {
    expect(normalize("  \u201cLeaks\u00a0cause\u201d \u2014 a soft\u00adhyphen, non\u2011breaking; drop.  ")).toBe('leaks cause" - a softhyphen, non-breaking; drop');
    expect(normalize("'Quoted.':;")).toBe("quoted");
  });
});

describe("extractJson", () => {
  it("tolerates fences and prose", () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a": {"b": 2}} done')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("no json here")).toThrow(SyntaxError);
  });
});

/** Returns scripted replies in order and records what it was sent. */
class FakeLLM implements LLM {
  model = "fake";
  requests: ChatMessage[][] = [];
  constructor(private replies: string[]) {}
  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    this.requests.push(messages);
    return { content: this.replies.shift() as string, reasoning: null, prompt_tokens: 100, completion_tokens: 50, latency_s: 1.0, model: this.model };
  }
}

async function run(replies: string[]) {
  const llm = new FakeLLM(replies);
  const calls: LlmCall[] = [];
  const [parsed, attempts] = await generateValidated<unknown>(llm, [{ role: "user", content: "explain" }], {
    purpose: "explain",
    alarmId: "A001",
    problemsOf: (p) => explanationProblems(p, EXCERPTS, SCHEMA),
    jsonSchema: SCHEMA,
    schemaName: "x",
    calls,
  });
  return { llm, parsed, attempts, calls };
}

describe("reject and retry", () => {
  it("a bad citation is rejected, then the retry succeeds", async () => {
    const fabricated = withCitations(
      { doc: "doe-sourcebook", page: 33, quote: "A leak this size will destroy the compressor within a week of running" },
      GOOD.citations[1],
    );
    const { llm, parsed, attempts, calls } = await run([JSON.stringify(fabricated), JSON.stringify(GOOD)]);
    expect(attempts).toBe(2);
    expect(parsed).toEqual(GOOD);
    expect(calls.map((c) => c.attempt)).toEqual([1, 2]);
    expect(calls[0]).toEqual({ purpose: "explain", attempt: 1, latency_s: 1, prompt_tokens: 100, completion_tokens: 50, tokens_per_s: 50 });
    const second = llm.requests[1];
    expect(second).toHaveLength(3);
    expect(second[1]).toEqual({ role: "assistant", content: JSON.stringify(fabricated) });
    const feedback = second[2].content;
    expect(feedback).toContain("rejected");
    expect(feedback).toContain("does not appear word for word");
    expect(feedback.startsWith("Your reply was rejected for these reasons:\n- citation 1: ")).toBe(true);
    expect(feedback.endsWith("\nCorrect them and send the complete reply again.")).toBe(true);
  });

  it("invalid JSON is retried", async () => {
    const { parsed, attempts } = await run(["I think it is a leak.", JSON.stringify(GOOD)]);
    expect(attempts).toBe(2);
    expect(parsed).toEqual(GOOD);
  });

  it("gives up after the maximum number of attempts", async () => {
    const fabricated = JSON.stringify(withCitations({ doc: "doe-sourcebook", page: 99, quote: "x ".repeat(10) }));
    await expect(run(Array(MAX_ATTEMPTS).fill(fabricated))).rejects.toThrow(StillInvalidError);
    await expect(run(Array(MAX_ATTEMPTS).fill(fabricated))).rejects.toThrow(/still invalid/);
  });
});

class FakeEmbedder implements Embedder {
  seen: string[] = [];
  async embedQueries(queries: string[]): Promise<Float32Array[]> {
    this.seen.push(...queries);
    return queries.map(() => Float32Array.from([1, 0, 0]));
  }
}

describe("retrieval", () => {
  const chunks: Chunk[] = [
    { id: "doe-p010-c1", doc: "doe-sourcebook", page: 10, printed_page: 5, text: "a" },
    { id: "doe-p033-c1", doc: "doe-sourcebook", page: 33, printed_page: 28, text: "b" },
    { id: "apu-s02-c1", doc: "apu-description", page: 2, printed_page: null, text: "c" },
  ];
  const vectors = Float32Array.from([0.1, 0.9, 0, 0.9, 0.1, 0, 1, 0, 0]);

  it("ranks manual chunks and always adds the unit description", async () => {
    const retriever = new Retriever(new FakeEmbedder(), chunks, vectors, 3);
    const found = await retriever.excerptsFor(["leak"], 1);
    expect(found.map((c) => c.id)).toEqual(["doe-p033-c1", "apu-s02-c1"]);
    expect(found[0].similarity).toBeCloseTo(0.9, 6);
    expect(found[1].similarity).toBeUndefined();
  });

  it("scores each chunk by its best query and keeps the top k", async () => {
    class TwoQueries implements Embedder {
      async embedQueries(): Promise<Float32Array[]> {
        return [Float32Array.from([1, 0, 0]), Float32Array.from([0, 1, 0])];
      }
    }
    const found = await new Retriever(new TwoQueries(), chunks, vectors, 3).search(["a", "b"], 2);
    expect(found.map((c) => [c.id, c.similarity])).toEqual([
      ["doe-p010-c1", 0.9],
      ["doe-p033-c1", 0.9],
    ]);
  });

  it("refuses chunks and embeddings that are out of sync", () => {
    expect(() => new Retriever(new FakeEmbedder(), chunks, vectors.slice(0, 6), 3)).toThrow(/out of sync/);
  });

  it("builds the query text with the instruction prefix", () => {
    expect(queryText("where is the leak")).toBe(`Instruct: ${QUERY_INSTRUCTION}\nQuery:where is the leak`);
  });

  it("formats excerpts as the prompt expects", () => {
    expect(formatExcerpts(EXCERPTS.slice(0, 2))).toBe(
      `[excerpt 1] doc=doe-sourcebook page=33\n${EXCERPTS[0].text}\n\n[excerpt 2] doc=apu-description page=2\n${EXCERPTS[1].text}`,
    );
  });

  it("derives the same queries from an evidence pack as the Python does", () => {
    const signal = (normal: [number, number], verdict?: string) => ({ normal_p05_p95: normal, ...(verdict ? { under_load: { mean: 0, min: 0, max: 0, verdict } } : {}) });
    const evidence = {
      alarm_id: "A000",
      top_contributing_signals: [{ signal: "DV_pressure" }, { signal: "TP2" }],
      signals: {
        DV_pressure: signal([-0.026, -0.014], "above normal"),
        Oil_temperature: signal([50.325, 69.225]),
        Reservoirs: signal([8.152, 9.954]),
      },
      compressor_duty: { under_load_share_last_30min: 0.808, normal_under_load_share_30min: { p50: 0.071, p95: 0.179, p99: 0.28 } },
      trend: { oil_temperature_max_last_60min: 73.65, reservoir_pressure_min_last_60min: 8.05 },
    } as unknown as Evidence;
    expect(retrievalQueries(evidence)).toEqual([
      "compressed air system leaks: how to detect, locate and repair them",
      "compressor runs loaded continuously and does not unload or reach cut-out pressure",
      "compressor controls: load/unload operation and excessive run time",
      "air dryer purge air and condensate drain valve stuck open wasting compressed air",
      "high compressor oil or discharge temperature: causes and maintenance",
      "separator, filter and compressor discharge pressure problems, pressure drop across components",
      "low system pressure and pressure drop: causes and troubleshooting",
      "preventive maintenance checklist for rotary screw compressor and air dryer",
    ]);
    const quiet = {
      ...evidence,
      top_contributing_signals: [{ signal: "Motor_current" }],
      signals: { ...evidence.signals, DV_pressure: signal([-0.026, -0.014]) },
      compressor_duty: { under_load_share_last_30min: null, normal_under_load_share_30min: { p50: 0.071, p95: 0.179, p99: 0.28 } },
      trend: { oil_temperature_max_last_60min: null, reservoir_pressure_min_last_60min: null },
    } as unknown as Evidence;
    expect(retrievalQueries(quiet)).toEqual([
      "compressed air system leaks: how to detect, locate and repair them",
      "compressor motor load, current draw and power at full load versus unloaded",
      "preventive maintenance checklist for rotary screw compressor and air dryer",
    ]);
  });
});
