#!/usr/bin/env node
// Screenshot the /cover page into docs/cover.png (1200x630).
//
//   pnpm build && pnpm start &      # or pnpm dev
//   pnpm cover                      # BASE_URL defaults to http://localhost:3000
//
// Rerun after the pipeline regenerates results, so the chart on the cover matches them.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const base = process.env.BASE_URL || "http://localhost:3000";
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "cover.png");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(`${base}/cover`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="alarm-chart"][data-state="ready"]');
await page.waitForTimeout(500); // let the canvases paint
await page.locator('[data-testid="cover"]').screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
