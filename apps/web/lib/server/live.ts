import "server-only";
import { type AlertContext, type ChatContext, type Chunk, type Prompts, Retriever, type Schemas, StillInvalidError, retrievalQueries } from "../explain-core";
import { pyCompact, topLevelRaw } from "../pyjson";
import type { Alert } from "../types";
import { type Embeddings, isAlarmId, loadAlertText, loadChunks, loadEmbeddings, loadPrompt, loadSchema } from "./data";
import { EmbedClient, LLMClient, UpstreamError, liveConfig, mode } from "./llm";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: err.message, ...err.extra }, { status: err.status });
  }
  if (err instanceof StillInvalidError) {
    return Response.json(
      { error: "The model's reply was rejected by the validator on every attempt, so nothing is shown.", problems: err.problems },
      { status: 502 },
    );
  }
  if (err instanceof UpstreamError) {
    return Response.json({ error: `The GPU droplet did not answer: ${err.message}.` }, { status: 502 });
  }
  console.error(err);
  return Response.json({ error: err instanceof Error ? err.message : "unexpected error" }, { status: 500 });
}

let kbCache: { key: string; chunks: Chunk[]; embeddings: Embeddings } | null = null;

function loadKb(): { chunks: Chunk[]; embeddings: Embeddings } {
  const key = process.env.FAULTLINE_DATA_DIR ?? "";
  if (kbCache && kbCache.key === key) return kbCache;
  const chunks = loadChunks();
  const embeddings = loadEmbeddings();
  if (!chunks || !embeddings) {
    throw new HttpError(
      503,
      "The manual has not been embedded yet, so there is nothing to retrieve from. " +
        "Run `python -m faultline.kb --embed` against the droplet, then rebuild the app.",
      { missing: "results/kb/embeddings.json and results/kb/embeddings.f32" },
    );
  }
  if (embeddings.count !== chunks.length || embeddings.chunk_ids.some((id, i) => chunks[i]?.id !== id)) {
    throw new HttpError(503, "chunks and embeddings are out of sync: run `python -m faultline.kb --embed`.");
  }
  kbCache = { key, chunks, embeddings };
  return kbCache;
}

export interface LiveSetup {
  retriever: Retriever;
  llm: LLMClient;
  prompts: Prompts;
  schemas: Schemas;
}

/** Everything a live route needs, or an HttpError that says exactly what is missing. */
export function liveSetup(): LiveSetup {
  if (mode() !== "live") {
    throw new HttpError(
      409,
      "This deployment is in replay mode: it shows cached results and does not call the GPU. " +
        "Set FAULTLINE_MODE=live with the droplet running to ask the model.",
      { mode: "replay" },
    );
  }
  const { config, missing } = liveConfig();
  if (!config) {
    throw new HttpError(503, `Live mode is on but ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not set.`, { mode: "live" });
  }
  const { chunks, embeddings } = loadKb();
  return {
    retriever: new Retriever(new EmbedClient(config), chunks, embeddings.vectors, embeddings.dim),
    llm: new LLMClient(config),
    prompts: {
      explain_system: loadPrompt("explain_system"),
      workorder_system: loadPrompt("workorder_system"),
      chat_system: loadPrompt("chat_system"),
    },
    schemas: { explanation: loadSchema("explanation"), work_order: loadSchema("work_order") },
  };
}

export interface LoadedAlert {
  alert: Alert;
  ctx: AlertContext;
  chatCtx: ChatContext;
}

export function loadAlertContext(alarmId: unknown): LoadedAlert {
  if (!isAlarmId(alarmId)) throw new HttpError(400, "alarm_id is required, for example \"A001\".");
  const text = loadAlertText(alarmId);
  if (text === null) throw new HttpError(404, `There is no alert ${alarmId}.`);
  const alert = JSON.parse(text) as Alert;
  const raw = topLevelRaw(text);
  if (!alert.evidence || !raw.evidence) throw new HttpError(404, `Alert ${alarmId} has no evidence pack.`);
  const ctx: AlertContext = { alarmId, evidence: alert.evidence, evidenceJson: pyCompact(raw.evidence) };
  const chatCtx: ChatContext = {
    ...ctx,
    explanationJson: pyCompact(raw.explanation ?? "null"),
    workOrderJson: pyCompact(raw.work_order ?? "null"),
    // The pipeline stores the queries with the explanation. Before it has run, derive the same ones from the evidence.
    retrievalQueries: alert.retrieval?.queries ?? retrievalQueries(alert.evidence),
  };
  return { alert, ctx, chatCtx };
}
