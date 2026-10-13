#!/usr/bin/env node
// Copy pipeline output into the web app. Runs before `dev` and `build`.
//
//   ../../results/replay/**          -> public/data/replay/**   (fetched by the browser)
//   ../../results/{bench,alarms,...} -> server-data/**          (read by server components and API routes)
//   ../../prompts/**                 -> server-data/prompts/**  (the same prompt files the Python pipeline uses)
//
// Both targets are git-ignored and rebuilt from scratch on every run, so nothing
// stale and nothing hand-edited can survive. Nothing under tests/ is ever read here.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(APP, "..", "..");
const RESULTS = path.join(REPO, "results");
const PROMPTS = path.join(REPO, "prompts");
const PUBLIC_DATA = path.join(APP, "public", "data");
const SERVER_DATA = path.join(APP, "server-data");

function fail(message) {
  console.error(`\nsync-data: ${message}\n`);
  process.exit(1);
}

if (!existsSync(path.join(RESULTS, "bench.json"))) {
  fail(
    `results/bench.json is missing (looked in ${RESULTS}).\n` +
      "The web app only shows what the pipeline wrote. Run the pipeline first:\n" +
      "  python -m faultline.evaluate && python -m faultline.evidence && python -m faultline.export_replay",
  );
}

// [source relative to results/, target dir, required]
const SERVER_FILES = [
  ["bench.json", true],
  ["alarms.json", true],
  ["alerts", true],
  ["replay/manifest.json", true],
  ["kb/sources.json", false],
  ["kb/chunks.json", false],
  ["kb/embeddings.json", false],
  ["kb/embeddings.f32", false],
  ["llm/summary.json", false],
  // Held-out second test (MetroPT-2), shown as one section of the benchmark view.
  ["metropt2/bench.json", false],
];
const PUBLIC_FILES = [
  ["replay/manifest.json", true],
  ["replay/days", true],
  ["replay/alarms", true],
];

function countFiles(p) {
  if (!existsSync(p)) return 0;
  if (!statSync(p).isDirectory()) return 1;
  return readdirSync(p).reduce((n, name) => n + countFiles(path.join(p, name)), 0);
}

function copyAll(list, targetRoot, report) {
  for (const [rel, required] of list) {
    const from = path.join(RESULTS, rel);
    if (!existsSync(from)) {
      if (required) fail(`results/${rel} is missing. Re-run the pipeline stage that writes it.`);
      report.missing.push(`results/${rel}`);
      continue;
    }
    const to = path.join(targetRoot, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
    report.copied[`results/${rel}`] = countFiles(to);
  }
}

rmSync(PUBLIC_DATA, { recursive: true, force: true });
rmSync(SERVER_DATA, { recursive: true, force: true });
mkdirSync(PUBLIC_DATA, { recursive: true });
mkdirSync(SERVER_DATA, { recursive: true });

const report = { synced_utc: new Date().toISOString().replace(/\.\d+Z$/, "Z"), copied: {}, missing: [] };
copyAll(PUBLIC_FILES, PUBLIC_DATA, report);
copyAll(SERVER_FILES, SERVER_DATA, report);

if (!existsSync(PROMPTS)) fail(`prompts/ is missing (looked in ${PROMPTS}).`);
cpSync(PROMPTS, path.join(SERVER_DATA, "prompts"), { recursive: true });
report.copied["prompts"] = countFiles(path.join(SERVER_DATA, "prompts"));

writeFileSync(path.join(SERVER_DATA, "sync.json"), JSON.stringify(report, null, 2) + "\n");

const total = Object.values(report.copied).reduce((a, b) => a + b, 0);
console.log(`sync-data: copied ${total} files from results/ and prompts/`);
if (report.missing.length) {
  console.log(`sync-data: not there yet (the app shows an empty state for these): ${report.missing.join(", ")}`);
}
