import { expect, test } from "@playwright/test";
import { readResult } from "./helpers";

// Live mode with a data dir that has no KB embeddings: the droplet is up, but
// `python -m faultline.kb --embed` has not been run. Live routes must say so.

const alarms: any[] = readResult("alarms.json").alarms;

test("live routes answer 503 and name the command when the KB embeddings are missing", async ({ request }) => {
  const status = await (await request.get("/api/status")).json();
  expect(status).toMatchObject({ mode: "live", live_configured: true, kb_embeddings: false });
  for (const [route, body] of [
    ["/api/explain", { alarm_id: alarms[0].id }],
    ["/api/chat", { alarm_id: alarms[0].id, question: "What should I check first?" }],
  ] as const) {
    const resp = await request.post(route, { data: body });
    expect(resp.status(), route).toBe(503);
    expect((await resp.json()).error).toContain("python -m faultline.kb --embed");
  }
});
