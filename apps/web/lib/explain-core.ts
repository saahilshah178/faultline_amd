// TypeScript port of faultline/explain.py and faultline/llm.py (the parts live mode
// needs). Pure: no filesystem and no environment access, so the unit tests can run the
// same cases as tests/test_explain.py against it. Keep it in step with the Python.

import Ajv, { type ValidateFunction } from "ajv";
import { pyDumps } from "./pyjson";
import type { ChatExample, Evidence, Excerpt, Explanation, LlmCall, WorkOrder } from "./types";

export const TOP_K = 8;
export const MAX_ATTEMPTS = 4;
export const MIN_QUOTE_WORDS = 6;
export const DOE_DOC = "doe-sourcebook";
export const APU_DOC = "apu-description";

// Qwen3-Embedding is instruction-aware: queries carry a task instruction, documents do not.
export const QUERY_INSTRUCTION =
  "Given a maintenance question about an industrial compressed air system, " +
  "retrieve passages from the manual that help answer it";

export const CHAT_CITATION = /\[(doe-sourcebook|apu-description) p\.\s?(\d+)\]/g;

export interface Chunk {
  id: string;
  doc: string;
  page: number;
  printed_page: number | null;
  text: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
  reasoning: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  latency_s: number;
  model: string;
  finish_reason?: string | null;
}

export interface ChatOptions {
  purpose: string;
  alarmId?: string;
  jsonSchema?: object | null;
  schemaName?: string;
  maxTokens?: number;
  temperature?: number;
  attempt?: number;
}

export interface LLM {
  model: string;
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult>;
}

/** Returns one L2-normalised row per query. */
export interface Embedder {
  embedQueries(queries: string[]): Promise<Float32Array[]>;
}

export function tokensPerSecond(r: Pick<ChatResult, "completion_tokens" | "latency_s">): number {
  return r.latency_s > 0 ? r.completion_tokens / r.latency_s : 0;
}

const round = (x: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};

// --- Retrieval ---------------------------------------------------------------

/** Search queries derived from the evidence pack. Deterministic, no LLM. */
export function retrievalQueries(evidence: Evidence): string[] {
  const duty = evidence.compressor_duty!;
  const signals = evidence.signals!;
  const top = new Set((evidence.top_contributing_signals ?? []).map((s) => s.signal));
  const trend = evidence.trend ?? {};
  const queries = ["compressed air system leaks: how to detect, locate and repair them"];

  const normalDuty = duty.normal_under_load_share_30min!.p95;
  if ((duty.under_load_share_last_30min || 0) > normalDuty) {
    queries.push("compressor runs loaded continuously and does not unload or reach cut-out pressure");
    queries.push("compressor controls: load/unload operation and excessive run time");
  }

  const above = (sig: string) => signals[sig]?.under_load?.verdict === "above normal";

  if (top.has("DV_pressure") || above("DV_pressure")) {
    queries.push("air dryer purge air and condensate drain valve stuck open wasting compressed air");
  }
  if (
    top.has("Oil_temperature") ||
    (trend.oil_temperature_max_last_60min || 0) > signals.Oil_temperature.normal_p05_p95![1]
  ) {
    queries.push("high compressor oil or discharge temperature: causes and maintenance");
  }
  if (top.has("H1") || top.has("TP2")) {
    queries.push("separator, filter and compressor discharge pressure problems, pressure drop across components");
  }
  if ((trend.reservoir_pressure_min_last_60min || 99) < signals.Reservoirs.normal_p05_p95![0]) {
    queries.push("low system pressure and pressure drop: causes and troubleshooting");
  }
  if (top.has("Motor_current")) {
    queries.push("compressor motor load, current draw and power at full load versus unloaded");
  }
  queries.push("preventive maintenance checklist for rotary screw compressor and air dryer");
  return queries;
}

/** The text sent to the embedding server for a query (prefix from the Qwen3-Embedding model card). */
export function queryText(query: string): string {
  return `Instruct: ${QUERY_INSTRUCTION}\nQuery:${query}`;
}

export function l2normalize(v: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** Cosine search over the embedded manual, plus the always-included unit description. */
export class Retriever {
  readonly unit: Chunk[];
  private readonly manual: number[];

  /** `vectors` holds chunks.length rows of `dim` float32 values, L2-normalised, in chunk order. */
  constructor(
    private readonly embedder: Embedder,
    private readonly chunks: Chunk[],
    private readonly vectors: Float32Array,
    private readonly dim: number,
  ) {
    if (chunks.length * dim !== vectors.length) {
      throw new Error("chunks and embeddings are out of sync: run python -m faultline.kb --embed");
    }
    this.unit = chunks.filter((c) => c.doc === APU_DOC);
    this.manual = chunks.flatMap((c, i) => (c.doc !== APU_DOC ? [i] : []));
  }

  async search(queries: string[], k = TOP_K): Promise<Excerpt[]> {
    const q = await this.embedder.embedQueries(queries);
    for (const row of q) {
      if (row.length !== this.dim) {
        throw new Error(`the embedding server returned ${row.length} dimensions but the KB has ${this.dim}`);
      }
    }
    const sims = this.manual.map((chunkIndex) => {
      const offset = chunkIndex * this.dim;
      let best = -Infinity;
      for (const row of q) {
        let dot = 0;
        for (let d = 0; d < this.dim; d++) dot += this.vectors[offset + d] * row[d];
        if (dot > best) best = dot;
      }
      return best;
    });
    const order = sims.map((_, i) => i).sort((a, b) => sims[b] - sims[a] || a - b);
    return order.slice(0, k).map((i) => ({ ...this.chunks[this.manual[i]], similarity: round(sims[i], 4) }));
  }

  async excerptsFor(queries: string[], k = TOP_K): Promise<Excerpt[]> {
    return [...(await this.search(queries, k)), ...this.unit];
  }
}

export function formatExcerpts(excerpts: Excerpt[]): string {
  return excerpts.map((e, i) => `[excerpt ${i + 1}] doc=${e.doc} page=${e.page}\n${e.text}`).join("\n\n");
}

// --- Validation --------------------------------------------------------------

const STRIP = new Set([" ", '"', "'", ".", ",", ";", ":"]);

export function normalize(text: string): string {
  text = text.replaceAll("\u00ad", "");
  for (const [a, b] of [
    ["\u2018", "'"],
    ["\u2019", "'"],
    ["\u201c", '"'],
    ["\u201d", '"'],
    ["\u2013", "-"],
    ["\u2014", "-"],
    ["\u2011", "-"],
    ["\u00a0", " "],
  ] as const) {
    text = text.replaceAll(a, b);
  }
  text = text.replace(/\s+/g, " ").trim().toLowerCase();
  // A word the PDF broke across a line ("com- pressed") matches its repaired form.
  // Python's \w is Unicode-aware, so spell that out here.
  text = text.replace(/([\p{L}\p{N}_])- ([\p{L}\p{N}_])/gu, "$1$2");
  let start = 0;
  let end = text.length;
  while (start < end && STRIP.has(text[start])) start++;
  while (end > start && STRIP.has(text[end - 1])) end--;
  return text.slice(start, end);
}

const pageKey = (doc: unknown, page: unknown) => `${String(doc)}\u0000${String(page)}`;
const py = (v: unknown) => (v === null || v === undefined ? "None" : String(v));
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

type LooseCitation = { doc?: unknown; page?: unknown; quote?: unknown };

export function citationProblems(citations: LooseCitation[], excerpts: Excerpt[]): string[] {
  const problems: string[] = [];
  const pages = new Set(excerpts.map((e) => pageKey(e.doc, e.page)));
  citations.forEach((c, index) => {
    const i = index + 1;
    const quote = normalize(typeof c.quote === "string" ? c.quote : "");
    const where = `${py(c.doc)} page ${py(c.page)}`;
    const known = typeof c.page === "number" && pages.has(pageKey(c.doc, c.page));
    if (!known) {
      problems.push(`citation ${i}: ${where} is not one of the excerpts you were given`);
    } else if (wordCount(quote) < MIN_QUOTE_WORDS) {
      problems.push(`citation ${i}: the quote is too short; copy at least 8 consecutive words`);
    } else if (!excerpts.some((e) => e.doc === c.doc && e.page === c.page && normalize(e.text).includes(quote))) {
      problems.push(
        `citation ${i}: the quote does not appear word for word in an excerpt from ${where}; ` +
          "copy one contiguous passage exactly",
      );
    }
  });
  if (!citations.some((c) => c.doc === DOE_DOC)) {
    problems.push("at least one citation must come from doc doe-sourcebook");
  }
  return problems;
}

const ajv = new Ajv({ allErrors: false, strict: false });
const compiled = new WeakMap<object, ValidateFunction>();

/** First JSON-schema violation as text, or null when the value conforms. */
export function schemaProblem(value: unknown, schema: object): string | null {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  if (validate(value)) return null;
  const err = validate.errors?.[0];
  const where = err?.instancePath ? `${err.instancePath} ` : "";
  return `schema: ${where}${err?.message ?? "does not match the schema"}`;
}

export function explanationProblems(explanation: unknown, excerpts: Excerpt[], schema: object): string[] {
  const problem = schemaProblem(explanation, schema);
  if (problem) return [problem];
  return citationProblems((explanation as Explanation).citations, excerpts);
}

export function chatCitations(answer: string): { doc: string; page: number; raw: string }[] {
  return [...answer.matchAll(CHAT_CITATION)].map((m) => ({ doc: m[1], page: parseInt(m[2], 10), raw: `[${m[1]} p.${m[2]}]` }));
}

export function chatProblems(answer: string, excerpts: Excerpt[]): string[] {
  const pages = new Set(excerpts.map((e) => pageKey(e.doc, e.page)));
  const bad = [...new Set(chatCitations(answer).filter((c) => !pages.has(pageKey(c.doc, c.page))).map((c) => c.raw))].sort();
  return bad.length ? [`these citations are not among the excerpts: ${bad.join(", ")}`] : [];
}

/** Parse a JSON object from model output, tolerating code fences or stray prose. */
export function extractJson(text: string): unknown {
  text = text.trim();
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }
  const fenced = /```(?:json)?\s*(\{.*\})\s*```/s.exec(text);
  if (fenced) return JSON.parse(fenced[1]);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new SyntaxError("no JSON object in model output");
}

// --- Generation --------------------------------------------------------------

export class StillInvalidError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(message);
    this.name = "StillInvalidError";
  }
}

export interface Rejection {
  purpose: string;
  attempt: number;
  problems: string[];
}

function callRecord(purpose: string, r: ChatResult, attempt: number): LlmCall {
  return {
    purpose,
    attempt,
    latency_s: round(r.latency_s, 3),
    prompt_tokens: r.prompt_tokens,
    completion_tokens: r.completion_tokens,
    tokens_per_s: round(tokensPerSecond(r), 2),
  };
}

/** Ask, validate, and on rejection feed the problems back and ask again. */
export async function generateValidated<T>(
  llm: LLM,
  messages: ChatMessage[],
  opts: {
    purpose: string;
    alarmId: string;
    problemsOf: (parsed: T) => string[];
    jsonSchema: object | null;
    schemaName: string;
    calls: LlmCall[];
    maxTokens?: number;
    rejections?: Rejection[];
  },
): Promise<[T, number]> {
  let convo = [...messages];
  let lastProblems: string[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await llm.chat(convo, {
      purpose: opts.purpose,
      alarmId: opts.alarmId,
      jsonSchema: opts.jsonSchema,
      schemaName: opts.schemaName,
      attempt,
      maxTokens: opts.maxTokens ?? 4096,
    });
    opts.calls.push(callRecord(opts.purpose, result, attempt));
    let parsed: T | null = null;
    try {
      parsed = (opts.jsonSchema !== null ? extractJson(result.content) : result.content.trim()) as T;
      lastProblems = opts.problemsOf(parsed);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      parsed = null;
      lastProblems = ["the reply was not a single valid JSON object"];
    }
    if (lastProblems.length === 0) return [parsed as T, attempt];
    opts.rejections?.push({ purpose: opts.purpose, attempt, problems: lastProblems });
    convo = [
      ...messages,
      { role: "assistant", content: result.content },
      {
        role: "user",
        content:
          "Your reply was rejected for these reasons:\n- " +
          lastProblems.join("\n- ") +
          "\nCorrect them and send the complete reply again.",
      },
    ];
  }
  throw new StillInvalidError(
    `${opts.alarmId} ${opts.purpose}: still invalid after ${MAX_ATTEMPTS} attempts: ${JSON.stringify(lastProblems)}`,
    lastProblems,
  );
}

/** `evidenceJson` must already be in Python json.dumps form (see lib/pyjson.ts). */
export function evidenceBlock(evidenceJson: string): string {
  return "ALARM EVIDENCE (JSON):\n" + evidenceJson;
}

export interface Prompts {
  explain_system: string;
  workorder_system: string;
  chat_system: string;
}

export interface Schemas {
  explanation: object;
  work_order: object;
}

/** What the generation functions need to know about one alert. */
export interface AlertContext {
  alarmId: string;
  evidence: Evidence;
  /** json.dumps(evidence, ensure_ascii=False), byte for byte. */
  evidenceJson: string;
}

export interface ExplainResult {
  explanation: Explanation;
  work_order: WorkOrder;
  retrieval: { queries: string[]; excerpts: Excerpt[] };
  llm: {
    model: string;
    generated_utc: string;
    explanation_attempts: number;
    citations_validated: true;
    calls: LlmCall[];
    wall_seconds: number;
    llm_seconds: number;
    prompt_tokens: number;
    completion_tokens: number;
    tokens_per_s: number | null;
  };
  rejections: Rejection[];
}

export function explainMessages(ctx: AlertContext, excerptText: string, prompts: Prompts): ChatMessage[] {
  return [
    { role: "system", content: prompts.explain_system },
    { role: "user", content: `${evidenceBlock(ctx.evidenceJson)}\n\nREFERENCE EXCERPTS:\n${excerptText}` },
  ];
}

export function workOrderMessages(ctx: AlertContext, explanationJson: string, excerptText: string, prompts: Prompts): ChatMessage[] {
  return [
    { role: "system", content: prompts.workorder_system },
    {
      role: "user",
      content: `${evidenceBlock(ctx.evidenceJson)}\n\nEXPLANATION (JSON):\n${explanationJson}\n\nREFERENCE EXCERPTS:\n${excerptText}`,
    },
  ];
}

function utcStamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function pickExcerpt(e: Excerpt): Excerpt {
  const out: Excerpt = { id: e.id, doc: e.doc, page: e.page, printed_page: e.printed_page, text: e.text };
  if (e.similarity !== undefined) out.similarity = e.similarity;
  return out;
}

/** Explanation and work order for one alarm. Unlike the Python batch, it does not answer the follow-up questions. */
export async function explainAlert(
  ctx: AlertContext,
  retriever: Retriever,
  llm: LLM,
  prompts: Prompts,
  schemas: Schemas,
): Promise<ExplainResult> {
  const calls: LlmCall[] = [];
  const rejections: Rejection[] = [];
  const t0 = performance.now();

  const queries = retrievalQueries(ctx.evidence);
  const excerpts = await retriever.excerptsFor(queries);
  const excerptText = formatExcerpts(excerpts);

  const [explanation, attempts] = await generateValidated<Explanation>(llm, explainMessages(ctx, excerptText, prompts), {
    purpose: "explain",
    alarmId: ctx.alarmId,
    problemsOf: (parsed) => explanationProblems(parsed, excerpts, schemas.explanation),
    jsonSchema: schemas.explanation,
    schemaName: "alarm_explanation",
    calls,
    rejections,
  });

  const [workOrder] = await generateValidated<WorkOrder>(
    llm,
    workOrderMessages(ctx, pyDumps(explanation), excerptText, prompts),
    {
      purpose: "work_order",
      alarmId: ctx.alarmId,
      problemsOf: (parsed) => {
        const problem = schemaProblem(parsed, schemas.work_order);
        return problem ? [problem] : [];
      },
      jsonSchema: schemas.work_order,
      schemaName: "work_order",
      calls,
      rejections,
    },
  );

  const wall = (performance.now() - t0) / 1000;
  const outTokens = calls.reduce((n, c) => n + c.completion_tokens, 0);
  const genSeconds = calls.reduce((n, c) => n + c.latency_s, 0);
  return {
    explanation,
    work_order: workOrder,
    retrieval: { queries, excerpts: excerpts.map(pickExcerpt) },
    llm: {
      model: llm.model,
      generated_utc: utcStamp(),
      explanation_attempts: attempts,
      citations_validated: true,
      calls,
      wall_seconds: round(wall, 2),
      llm_seconds: round(genSeconds, 2),
      prompt_tokens: calls.reduce((n, c) => n + c.prompt_tokens, 0),
      completion_tokens: outTokens,
      tokens_per_s: genSeconds ? round(outTokens / genSeconds, 2) : null,
    },
    rejections,
  };
}

export interface ChatContext extends AlertContext {
  /** json.dumps of the explanation and work order shown to the technician ("null" when not generated). */
  explanationJson: string;
  workOrderJson: string;
  /** The alert's stored retrieval queries; the first two are reused for every question. */
  retrievalQueries: string[];
}

export function chatMessages(
  ctx: ChatContext,
  question: string,
  excerpts: Excerpt[],
  history: ChatMessage[],
  prompts: Prompts,
): ChatMessage[] {
  const context =
    `${evidenceBlock(ctx.evidenceJson)}\n\nEXPLANATION (JSON):\n${ctx.explanationJson}\n\nWORK ORDER (JSON):\n` +
    `${ctx.workOrderJson}\n\nREFERENCE EXCERPTS:\n${formatExcerpts(excerpts)}`;
  return [
    { role: "system", content: prompts.chat_system },
    { role: "user", content: context },
    { role: "assistant", content: "Understood. What is your question?" },
    ...history,
    { role: "user", content: question },
  ];
}

export interface ChatAnswer extends ChatExample {
  excerpts: Excerpt[];
  attempts: number;
  calls: LlmCall[];
  rejections: Rejection[];
}

/** Technician follow-up: same evidence, retrieval refreshed for the question. */
export async function answerQuestion(
  ctx: ChatContext,
  question: string,
  retriever: Retriever,
  llm: LLM,
  prompts: Prompts,
  history: ChatMessage[] = [],
): Promise<ChatAnswer> {
  const calls: LlmCall[] = [];
  const rejections: Rejection[] = [];
  const excerpts = await retriever.excerptsFor([question, ...ctx.retrievalQueries.slice(0, 2)], 6);
  const [answer, attempts] = await generateValidated<string>(llm, chatMessages(ctx, question, excerpts, history, prompts), {
    purpose: "chat",
    alarmId: ctx.alarmId,
    problemsOf: (text) => chatProblems(text, excerpts),
    jsonSchema: null,
    schemaName: "",
    calls,
    maxTokens: 2048,
    rejections,
  });
  const seen = new Map<string, { doc: string; page: number }>();
  for (const c of chatCitations(answer)) seen.set(pageKey(c.doc, c.page), { doc: c.doc, page: c.page });
  const cited = [...seen.values()].sort((a, b) => (a.doc < b.doc ? -1 : a.doc > b.doc ? 1 : a.page - b.page));
  return {
    question,
    answer,
    citations: cited.map(({ doc, page }) => ({
      doc,
      page,
      chunk_ids: excerpts.filter((e) => e.doc === doc && e.page === page).map((e) => e.id),
    })),
    excerpts: excerpts.filter((e) => seen.has(pageKey(e.doc, e.page))).map(pickExcerpt),
    attempts,
    calls,
    rejections,
  };
}
