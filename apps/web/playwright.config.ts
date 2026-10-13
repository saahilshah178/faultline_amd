import { defineConfig, devices } from "@playwright/test";

// Three copies of the app, all started with `next start` from builds made by
// tests/e2e/prepare.mjs, plus the mock model server:
//
//   replay  :3210  the real pipeline results, replay mode, no outside calls
//   live    :3211  live mode against the mock, fixture data dir (.e2e/live/data)
//   noembed :3212  live mode with a data dir that has no KB embeddings
//   mock    :3219  OpenAI-compatible mock (tests/mock/openai-mock.mjs)

export const PORTS = { replay: 3210, live: 3211, noembed: 3212, mock: 3219 };
export const MOCK_KEY = "test-key";

const nextStart = (port: number) => `node node_modules/next/dist/bin/next start -p ${port} -H 127.0.0.1`;
const mockUrl = `http://127.0.0.1:${PORTS.mock}/v1`;
const liveEnv = { FAULTLINE_MODE: "live", LLM_URL: mockUrl, EMBED_URL: mockUrl, VLLM_API_KEY: MOCK_KEY, LLM_MODEL: "", EMBED_MODEL: "" };
const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } };

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "replay", testMatch: /replay\.spec\.ts$/, use: { ...desktop, baseURL: `http://127.0.0.1:${PORTS.replay}` } },
    { name: "live", testMatch: /live\.spec\.ts$/, use: { ...desktop, baseURL: `http://127.0.0.1:${PORTS.live}` } },
    { name: "live-no-embeddings", testMatch: /noembed\.spec\.ts$/, use: { ...desktop, baseURL: `http://127.0.0.1:${PORTS.noembed}` } },
  ],
  webServer: [
    {
      command: "node tests/mock/openai-mock.mjs",
      url: `http://127.0.0.1:${PORTS.mock}/__mock/health`,
      env: { MOCK_PORT: String(PORTS.mock), MOCK_API_KEY: MOCK_KEY },
      reuseExistingServer: false,
    },
    {
      command: nextStart(PORTS.replay),
      url: `http://127.0.0.1:${PORTS.replay}/api/status`,
      // Empty strings on purpose: replay mode must work with no droplet settings at all.
      env: { NEXT_DIST_DIR: ".e2e/replay/.next", FAULTLINE_MODE: "replay", FAULTLINE_DATA_DIR: "", LLM_URL: "", EMBED_URL: "", VLLM_API_KEY: "" },
      reuseExistingServer: false,
    },
    {
      command: nextStart(PORTS.live),
      url: `http://127.0.0.1:${PORTS.live}/api/status`,
      env: { NEXT_DIST_DIR: ".e2e/live/.next", FAULTLINE_DATA_DIR: ".e2e/live/data", ...liveEnv },
      reuseExistingServer: false,
    },
    {
      command: nextStart(PORTS.noembed),
      url: `http://127.0.0.1:${PORTS.noembed}/api/status`,
      env: { NEXT_DIST_DIR: ".e2e/replay/.next", FAULTLINE_DATA_DIR: ".e2e/noembed/data", ...liveEnv },
      reuseExistingServer: false,
    },
  ],
});
