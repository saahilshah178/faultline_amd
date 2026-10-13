import "server-only";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Chunk } from "../explain-core";
import type { Alarm, Alert, Bench, KbSource, LlmSummary, ReplayManifest } from "../types";

// Everything the server shows or sends to the model is read from this directory,
// which scripts/sync-data.mjs fills from ../../results and ../../prompts.
// FAULTLINE_DATA_DIR points it elsewhere (the end-to-end tests use a temp copy).
export function dataDir(): string {
  const override = process.env.FAULTLINE_DATA_DIR;
  if (override) return path.resolve(/* turbopackIgnore: true */ override);
  return path.join(/* turbopackIgnore: true */ process.cwd(), "server-data");
}

function file(...parts: string[]): string {
  return path.join(dataDir(), ...parts);
}

export function has(...parts: string[]): boolean {
  return existsSync(file(...parts));
}

export function readText(...parts: string[]): string | null {
  const p = file(...parts);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

export function readJson<T>(...parts: string[]): T | null {
  const text = readText(...parts);
  if (text === null) return null;
  return JSON.parse(text) as T;
}

export function loadBench(): Bench | null {
  return readJson<Bench>("bench.json");
}

/** The same benchmark run on the held-out MetroPT-2 recording, if the pipeline has produced it. */
export function loadSecondBench(): Bench | null {
  return readJson<Bench>("metropt2", "bench.json");
}

export function loadAlarms(): Alarm[] {
  return readJson<{ alarms: Alarm[] }>("alarms.json")?.alarms ?? [];
}

const ALARM_ID = /^[A-Za-z0-9_-]{1,32}$/;

export function isAlarmId(id: unknown): id is string {
  return typeof id === "string" && ALARM_ID.test(id);
}

export function loadAlertText(id: string): string | null {
  if (!isAlarmId(id)) return null;
  return readText("alerts", `${id}.json`);
}

export function loadAlert(id: string): Alert | null {
  const text = loadAlertText(id);
  return text === null ? null : (JSON.parse(text) as Alert);
}

export function listAlertIds(): string[] {
  const dir = file("alerts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^A\d+\.json$/.test(name))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
}

export function loadManifest(): ReplayManifest | null {
  return readJson<ReplayManifest>("replay", "manifest.json");
}

export function loadSources(): KbSource[] {
  return readJson<KbSource[]>("kb", "sources.json") ?? [];
}

export function loadChunks(): Chunk[] | null {
  return readJson<Chunk[]>("kb", "chunks.json");
}

export function loadLlmSummary(): LlmSummary | null {
  return readJson<LlmSummary>("llm", "summary.json");
}

export interface Embeddings {
  model: string;
  count: number;
  dim: number;
  chunk_ids: string[];
  vectors: Float32Array;
}

export function hasEmbeddings(): boolean {
  return has("kb", "embeddings.json") && has("kb", "embeddings.f32");
}

/** results/kb/embeddings.{json,f32}: little-endian float32, count x dim, rows L2-normalised. */
export function loadEmbeddings(): Embeddings | null {
  const meta = readJson<{ model: string; count: number; dim: number; normalized?: boolean; chunk_ids: string[] }>("kb", "embeddings.json");
  const binPath = file("kb", "embeddings.f32");
  if (!meta || !existsSync(binPath)) return null;
  const buf = readFileSync(binPath);
  if (buf.byteLength !== meta.count * meta.dim * 4) {
    throw new Error(
      `kb/embeddings.f32 holds ${buf.byteLength} bytes but embeddings.json describes ${meta.count} x ${meta.dim} float32 values: run python -m faultline.kb --embed`,
    );
  }
  const vectors = new Float32Array(meta.count * meta.dim);
  for (let i = 0; i < vectors.length; i++) vectors[i] = buf.readFloatLE(i * 4);
  return { model: meta.model, count: meta.count, dim: meta.dim, chunk_ids: meta.chunk_ids, vectors };
}

/** A prompt file, read exactly as the Python pipeline reads it (stripped). */
export function loadPrompt(name: string): string {
  const text = readText("prompts", `${name}.md`);
  if (text === null) throw new Error(`prompts/${name}.md is missing from the data directory`);
  return text.trim();
}

export function loadSchema(name: string): object {
  const schema = readJson<object>("prompts", "schemas", `${name}.schema.json`);
  if (schema === null) throw new Error(`prompts/schemas/${name}.schema.json is missing from the data directory`);
  return schema;
}
