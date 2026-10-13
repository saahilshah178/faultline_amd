#!/usr/bin/env node
// TEST ONLY. Prepares what the end-to-end tests need, then builds the app twice:
//
//   .e2e/replay/.next   the app exactly as it deploys, from the real pipeline results
//   .e2e/live/.next     the same app built against .e2e/live/data, a temp copy of the
//                       data dir with (a) fixture KB embeddings, (b) one alert given a
//                       synthetic cached explanation, (c) a synthetic llm/summary.json
//   .e2e/noembed/data   a temp copy with no embeddings, for the 503 test
//
// Synthetic content comes only from tests/fixtures and tests/mock and is written only
// under .e2e/ (git-ignored). `pnpm dev` and `pnpm build` never read it.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MOCK_DIM, MOCK_EMBED_MODEL, embedText } from "../mock/embed.mjs";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const E2E = path.join(APP, ".e2e");
const SERVER_DATA = path.join(APP, "server-data");
const LIVE_DATA = path.join(E2E, "live", "data");
const NOEMBED_DATA = path.join(E2E, "noembed", "data");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 1) + "\n");
};

execFileSync(process.execPath, ["scripts/sync-data.mjs"], { cwd: APP, stdio: "inherit" });

for (const dir of [LIVE_DATA, NOEMBED_DATA]) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.dirname(dir), { recursive: true });
  cpSync(SERVER_DATA, dir, { recursive: true });
}
// "The droplet is up but the manual has not been embedded": no embeddings, no LLM summary.
for (const rel of ["kb/embeddings.json", "kb/embeddings.f32", "llm/summary.json"]) {
  rmSync(path.join(NOEMBED_DATA, rel), { force: true });
}

// --- which alerts the live tests use (looked up, never hard-coded) -------------
const alarms = readJson(path.join(SERVER_DATA, "alarms.json")).alarms;
const credited = alarms.filter((a) => /^F\d+$/.test(a.attribution));
const liveAlarm = credited.find((a) => a.attribution === "F2") ?? credited[0];
const afterAlarm = [...credited].reverse().find((a) => a.id !== liveAlarm?.id);
if (!liveAlarm || !afterAlarm) {
  console.error("prepare: results/alarms.json needs alarms credited to at least two failures for the live tests.");
  process.exit(1);
}

// --- fixture embeddings for every KB chunk -------------------------------------
const chunks = readJson(path.join(SERVER_DATA, "kb", "chunks.json"));
const bin = Buffer.alloc(chunks.length * MOCK_DIM * 4);
chunks.forEach((chunk, row) => {
  embedText(chunk.text, MOCK_DIM).forEach((x, d) => bin.writeFloatLE(x, (row * MOCK_DIM + d) * 4));
});
writeFileSync(path.join(LIVE_DATA, "kb", "embeddings.f32"), bin);
writeJson(path.join(LIVE_DATA, "kb", "embeddings.json"), {
  model: MOCK_EMBED_MODEL,
  count: chunks.length,
  dim: MOCK_DIM,
  normalized: true,
  chunk_ids: chunks.map((c) => c.id),
});

// --- the alert that is regenerated live starts with nothing cached --------------
const livePath = path.join(LIVE_DATA, "alerts", `${liveAlarm.id}.json`);
writeJson(livePath, { ...readJson(livePath), explanation: null, work_order: null, chat_examples: [], retrieval: null, llm: null });

// --- one alert in the "after the pipeline ran" state, from the fixture ----------
const fixture = readJson(path.join(APP, "tests", "fixtures", "after-state.json"));
const words = (text) => text.split(/\s+/).filter(Boolean);
const quoteOf = (chunk) => {
  const w = words(chunk.text);
  let end = Math.min(16, w.length);
  while (end < w.length && w[end - 1].endsWith("-")) end++;
  return w.slice(2, end).join(" ");
};
const manual = chunks.filter((c) => c.doc === "doe-sourcebook" && words(c.text).length >= 60);
const unit = chunks.filter((c) => c.doc === "apu-description");
const pick = (share) => manual[Math.floor(manual.length * share)];
const [doeA, doeB] = [pick(0.3), pick(0.6)];
// A chunk the chat answer cites that is NOT among the alert's stored excerpts.
const doeChat = manual.find((c) => c.page !== doeA.page && c.page !== doeB.page && c.id !== pick(0.3).id);
const citations = [
  { doc: doeA.doc, page: doeA.page, quote: quoteOf(doeA) },
  { doc: doeB.doc, page: doeB.page, quote: quoteOf(doeB) },
  { doc: unit[0].doc, page: unit[0].page, quote: quoteOf(unit[0]) },
];
const chatCites = [
  { chunk: doeChat, text: `[${doeChat.doc} p.${doeChat.page}]` },
  { chunk: unit[0], text: `[${unit[0].doc} p.${unit[0].page}]` },
];
const chatExamples = fixture.chat_questions.map((question, i) => {
  const cite = chatCites[i % chatCites.length];
  return {
    question,
    answer: fixture.chat_answer_template.replace("{CITE}", cite.text),
    citations: [{ doc: cite.chunk.doc, page: cite.chunk.page, chunk_ids: chunks.filter((c) => c.doc === cite.chunk.doc && c.page === cite.chunk.page).map((c) => c.id) }],
  };
});
const afterPath = path.join(LIVE_DATA, "alerts", `${afterAlarm.id}.json`);
const after = {
  ...readJson(afterPath),
  explanation: { ...fixture.explanation, citations },
  work_order: fixture.work_order,
  chat_examples: chatExamples,
  retrieval: {
    queries: ["[test fixture] synthetic retrieval query"],
    excerpts: [{ ...doeA, similarity: 0.5 }, { ...doeB, similarity: 0.4 }, ...unit],
  },
  llm: fixture.llm,
};
writeJson(afterPath, after);

const llmSummary = readJson(path.join(APP, "tests", "fixtures", "llm-summary.json"));
writeJson(path.join(LIVE_DATA, "llm", "summary.json"), llmSummary);

writeJson(path.join(E2E, "fixture.json"), {
  liveId: liveAlarm.id,
  afterId: afterAlarm.id,
  after: { explanation: after.explanation, work_order: after.work_order, chat_examples: chatExamples, llm: after.llm },
  chatExtraChunkId: doeChat.id,
  llmSummary,
});
console.log(`prepare: live alert ${liveAlarm.id}, after-state alert ${afterAlarm.id}, ${chunks.length} fixture embeddings (${MOCK_DIM}d)`);

// --- builds ---------------------------------------------------------------------
const next = path.join(APP, "node_modules", "next", "dist", "bin", "next");
function build(label, env) {
  console.log(`prepare: building ${label}`);
  execFileSync(process.execPath, [next, "build"], { cwd: APP, stdio: "inherit", env: { ...process.env, ...env } });
}
if (process.env.E2E_SKIP_BUILD !== "1") {
  build("replay (real results)", { NEXT_DIST_DIR: ".e2e/replay/.next", FAULTLINE_DATA_DIR: "", FAULTLINE_MODE: "replay" });
  build("live (fixture data dir)", { NEXT_DIST_DIR: ".e2e/live/.next", FAULTLINE_DATA_DIR: LIVE_DATA, FAULTLINE_MODE: "live" });
}
