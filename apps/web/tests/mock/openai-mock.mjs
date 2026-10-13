#!/usr/bin/env node
// TEST ONLY. A tiny OpenAI-compatible server standing in for the two vLLM servers on
// the GPU droplet: GET /v1/models, POST /v1/embeddings, POST /v1/chat/completions.
//
// Everything it returns is synthetic and says so. It is started only by the
// end-to-end tests (playwright.config.ts) and is the only place synthetic model
// output exists. Its first explanation reply carries a fabricated citation; once the
// app feeds the rejection back, its next reply quotes the retrieved excerpts exactly.

import http from "node:http";
import { FABRICATED_QUOTE, MOCK_ANSWER_PREFIX, MOCK_FIRST_SUMMARY, MOCK_VALID_SUMMARY, MOCK_WORK_ORDER_TITLE, REASONING_MARKER } from "./constants.mjs";
import { MOCK_DIM, MOCK_EMBED_MODEL, embedText } from "./embed.mjs";

const PORT = Number(process.env.MOCK_PORT ?? 3219);
const KEY = process.env.MOCK_API_KEY ?? "test-key";


let requests = [];

function parseExcerpts(text) {
  const start = text.lastIndexOf("REFERENCE EXCERPTS:\n");
  if (start === -1) return [];
  const body = text.slice(start + "REFERENCE EXCERPTS:\n".length);
  const out = [];
  const re = /\[excerpt (\d+)\] doc=(\S+) page=(\d+)\n([\s\S]*?)(?=\n\n\[excerpt \d+\] doc=|$)/g;
  for (const m of body.matchAll(re)) out.push({ n: Number(m[1]), doc: m[2], page: Number(m[3]), text: m[4] });
  return out;
}

/** Twelve consecutive words copied from an excerpt: a quote the validator will accept. */
function quoteFrom(excerpt) {
  const words = excerpt.text.split(/\s+/).filter(Boolean);
  let n = 12;
  // do not stop on the first half of a word the PDF broke across a line ("com-")
  while (n < words.length && words[n - 1].endsWith("-")) n++;
  return words.slice(0, n).join(" ");
}

function explanation(excerpts, fabricate) {
  const doe = excerpts.find((e) => e.doc === "doe-sourcebook");
  const apu = excerpts.find((e) => e.doc === "apu-description");
  return {
    summary: fabricate ? MOCK_FIRST_SUMMARY : MOCK_VALID_SUMMARY,
    likely_causes: [{ cause: "[mock model] Synthetic cause", evidence: "[mock model] synthetic evidence text, not a reading", confidence: "low" }],
    recommended_actions: [
      { action: "[mock model] Synthetic action one", why: "[mock model] synthetic reason", urgency: "this_shift" },
      { action: "[mock model] Synthetic action two", why: "[mock model] synthetic reason", urgency: "this_week" },
    ],
    citations: [
      { doc: "doe-sourcebook", page: doe?.page ?? 1, quote: fabricate ? FABRICATED_QUOTE : quoteFrom(doe) },
      { doc: "apu-description", page: apu?.page ?? 1, quote: quoteFrom(apu) },
    ],
  };
}

const WORK_ORDER = {
  title: MOCK_WORK_ORDER_TITLE,
  asset: "[mock model] Synthetic asset",
  symptom: "[mock model] Synthetic symptom text",
  suspected_cause: "[mock model] Synthetic suspected cause",
  steps: ["[mock model] Step one", "[mock model] Step two", "[mock model] Step three", "[mock model] Step four"],
  parts_to_check: ["[mock model] Part A", "[mock model] Part B"],
  priority: "P2",
  priority_reason: "[mock model] Synthetic priority reason",
};

function chatCompletion(body) {
  const messages = body.messages ?? [];
  const schemaName = body.response_format?.json_schema?.name ?? null;
  const context = messages.find((m) => m.role === "user")?.content ?? "";
  const excerpts = parseExcerpts(context);
  const rejected = messages.some((m) => m.role === "user" && m.content.startsWith("Your reply was rejected"));
  let content;
  if (schemaName === "alarm_explanation") {
    content = JSON.stringify(explanation(excerpts, !rejected));
  } else if (schemaName === "work_order") {
    content = JSON.stringify(WORK_ORDER);
  } else {
    const doe = excerpts.find((e) => e.doc === "doe-sourcebook");
    const question = messages[messages.length - 1]?.content ?? "";
    content = `${MOCK_ANSWER_PREFIX} "${question}". It cites a retrieved page [doe-sourcebook p.${doe?.page ?? 1}].`;
  }
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    model: body.model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, reasoning: `${REASONING_MARKER}: the mock's private reasoning.` } }],
    usage: { prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4), completion_tokens: Math.max(Math.ceil(content.length / 4), 60) },
  };
}

function send(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/__mock/requests") return send(res, 200, requests);
    if (url.pathname === "/__mock/reset") {
      requests = [];
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__mock/health") return send(res, 200, { ok: true });

    if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, { error: { message: "bad api key" } });

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return send(res, 200, { object: "list", data: [{ id: "openai/gpt-oss-120b", object: "model" }] });
    }
    if (req.method === "POST" && url.pathname === "/v1/embeddings") {
      const body = await readBody(req);
      const input = Array.isArray(body.input) ? body.input : [body.input];
      requests.push({ path: url.pathname, model: body.model, input });
      return send(res, 200, {
        object: "list",
        model: MOCK_EMBED_MODEL,
        // returned out of order on purpose: the client must sort by index
        data: input.map((text, index) => ({ object: "embedding", index, embedding: Array.from(embedText(text, MOCK_DIM)).map((x) => x * 3) })).reverse(),
      });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await readBody(req);
      requests.push({
        path: url.pathname,
        model: body.model,
        reasoning_effort: body.reasoning_effort ?? null,
        response_format: body.response_format ? { type: body.response_format.type, name: body.response_format.json_schema?.name, strict: body.response_format.json_schema?.strict, has_schema: !!body.response_format.json_schema?.schema } : null,
        max_tokens: body.max_tokens,
        temperature: body.temperature,
        roles: (body.messages ?? []).map((m) => m.role),
        system: body.messages?.[0]?.content ?? null,
        first_user: body.messages?.[1]?.content ?? null,
        last_message: body.messages?.[body.messages.length - 1]?.content ?? null,
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      return send(res, 200, chatCompletion(body));
    }
    return send(res, 404, { error: { message: `no route ${req.method} ${url.pathname}` } });
  } catch (err) {
    return send(res, 500, { error: { message: String(err) } });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`openai mock listening on http://127.0.0.1:${PORT}/v1`);
});
