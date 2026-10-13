import "server-only";
import { type ChatMessage, type ChatOptions, type ChatResult, type Embedder, type LLM, l2normalize, queryText } from "../explain-core";

// Clients for the two vLLM servers on the droplet (OpenAI-compatible HTTP), ported
// from faultline/llm.py. Only server code imports this: the browser never sees the
// droplet address or the API key.

export type Mode = "replay" | "live";

export function mode(): Mode {
  return process.env.FAULTLINE_MODE === "live" ? "live" : "replay";
}

export interface LiveConfig {
  llmUrl: string;
  embedUrl: string;
  apiKey: string;
  llmModel: string;
  embedModel: string;
  reasoningEffort: string;
}

const strip = (url: string) => url.replace(/\/+$/, "");

export function liveConfig(): { config: LiveConfig | null; missing: string[] } {
  const env = process.env;
  const missing = ["LLM_URL", "EMBED_URL", "VLLM_API_KEY"].filter((name) => !env[name]);
  if (missing.length) return { config: null, missing };
  return {
    missing,
    config: {
      llmUrl: strip(env.LLM_URL!),
      embedUrl: strip(env.EMBED_URL!),
      apiKey: env.VLLM_API_KEY!,
      llmModel: env.LLM_MODEL || "openai/gpt-oss-120b",
      embedModel: env.EMBED_MODEL || "Qwen/Qwen3-Embedding-0.6B",
      // gpt-oss always reasons before answering; "low" keeps that short.
      reasoningEffort: env.LLM_REASONING_EFFORT ?? "low",
    },
  };
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

async function post(url: string, apiKey: string, body: unknown, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    const reason = err instanceof Error ? (err.name === "TimeoutError" ? "timed out" : err.message) : String(err);
    throw new UpstreamError(`could not reach the model server: ${reason}`);
  }
}

export class LLMClient implements LLM {
  readonly model: string;

  constructor(
    private readonly config: LiveConfig,
    private readonly timeoutMs = 300_000,
  ) {
    this.model = config.llmModel;
  }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.2,
    };
    if (this.config.reasoningEffort && this.model.includes("gpt-oss")) {
      body.reasoning_effort = this.config.reasoningEffort;
    }
    if (options.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: options.schemaName ?? "response", schema: options.jsonSchema, strict: true },
      };
    }
    // vLLM occasionally fails a gpt-oss request with a Harmony parsing error (HTTP 5xx).
    // One immediate retry clears it; the failed try is not timed.
    let resp!: Response;
    let latency = 0;
    for (const triesLeft of [2, 1, 0]) {
      const t0 = performance.now();
      resp = await post(`${this.config.llmUrl}/chat/completions`, this.config.apiKey, body, this.timeoutMs);
      latency = (performance.now() - t0) / 1000;
      if (resp.status < 500 || triesLeft === 0) break;
    }
    if (!resp.ok) {
      throw new UpstreamError(`the model server answered HTTP ${resp.status}`, resp.status);
    }
    const data = (await resp.json()) as {
      model?: string;
      choices: { message: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices[0];
    const message = choice.message;
    return {
      // The answer is `content`. gpt-oss sends its reasoning separately; it is kept out of the answer.
      content: message.content || "",
      reasoning: message.reasoning || message.reasoning_content || null,
      prompt_tokens: Math.trunc(data.usage?.prompt_tokens ?? 0),
      completion_tokens: Math.trunc(data.usage?.completion_tokens ?? 0),
      latency_s: latency,
      model: data.model ?? this.model,
      finish_reason: choice.finish_reason ?? null,
    };
  }
}

export class EmbedClient implements Embedder {
  constructor(
    private readonly config: LiveConfig,
    private readonly timeoutMs = 120_000,
  ) {}

  private async embed(texts: string[], batch = 32): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += batch) {
      const resp = await post(
        `${this.config.embedUrl}/embeddings`,
        this.config.apiKey,
        { model: this.config.embedModel, input: texts.slice(i, i + batch) },
        this.timeoutMs,
      );
      if (!resp.ok) throw new UpstreamError(`the embedding server answered HTTP ${resp.status}`, resp.status);
      const data = (await resp.json()) as { data: { index: number; embedding: number[] }[] };
      const items = [...data.data].sort((a, b) => a.index - b.index);
      for (const item of items) vectors.push(item.embedding);
    }
    return vectors;
  }

  /** Prefix format from the Qwen3-Embedding model card. vLLM does not add it. */
  async embedQueries(queries: string[]): Promise<Float32Array[]> {
    const vectors = await this.embed(queries.map(queryText));
    return vectors.map((v) => l2normalize(v));
  }
}

/** Is the droplet answering? Probes GET <LLM_URL>/models with a short timeout. */
export async function probe(config: LiveConfig, timeoutMs = 2500): Promise<boolean> {
  try {
    const resp = await fetch(`${config.llmUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    return resp.ok;
  } catch {
    return false;
  }
}
