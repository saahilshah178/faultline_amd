import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { PORTS } from "../../playwright.config";
import { FABRICATED_QUOTE, MOCK_ANSWER_PREFIX, MOCK_FIRST_SUMMARY, MOCK_VALID_SUMMARY, MOCK_WORK_ORDER_TITLE, REASONING_MARKER } from "../mock/constants.mjs";
import { RESULTS, readFixture, readResult } from "./helpers";

// Live mode against the mock model server (tests/mock/openai-mock.mjs), with the app
// reading a temp data dir that holds fixture embeddings and one alert in the
// "after the pipeline ran" state. This is the only place synthetic model output appears.

const MOCK = `http://127.0.0.1:${PORTS.mock}`;
const fixture = readFixture();
const QUERY_PREFIX = "Instruct: Given a maintenance question about an industrial compressed air system, retrieve passages from the manual that help answer it\nQuery:";

test.describe("live mode against the mock droplet", () => {
  test.beforeEach(async ({ request }) => {
    await request.post(`${MOCK}/__mock/reset`);
  });

  test("status reports live mode and a reachable model server", async ({ request, page }) => {
    const status = await (await request.get("/api/status")).json();
    expect(status).toMatchObject({ mode: "live", live_configured: true, droplet_reachable: true, kb_embeddings: true });
    await page.goto("/");
    await expect(page.getByTestId("mode-badge")).toHaveAttribute("data-mode", "live");
    await expect(page.getByTestId("mode-badge")).toHaveAttribute("data-reachable", "true");
  });

  test("regenerate live: the fabricated citation is rejected and the valid reply is shown", async ({ page, request }) => {
    await page.goto(`/alerts/${fixture.liveId}`);
    await expect(page.getByTestId("mode-badge")).toHaveAttribute("data-mode", "live");
    await expect(page.getByTestId("explanation")).toHaveAttribute("data-state", "missing");

    await page.getByTestId("regenerate").click();
    await expect(page.getByTestId("live-result")).toBeVisible({ timeout: 30_000 });

    // The first reply was rejected for its invented quote; the second was accepted.
    await expect(page.getByTestId("live-attempts")).toHaveText("2");
    await expect(page.getByTestId("live-rejections")).toContainText("explain, attempt 1");
    await expect(page.getByTestId("live-rejections")).toContainText("does not appear word for word");
    const explanation = page.getByTestId("explanation");
    await expect(explanation).toHaveAttribute("data-state", "ready");
    await expect(explanation).toHaveAttribute("data-origin", "live");
    await expect(page.getByTestId("explanation-summary")).toHaveText(MOCK_VALID_SUMMARY);
    const body = await page.locator("body").innerText();
    expect(body).not.toContain(FABRICATED_QUOTE);
    expect(body).not.toContain(MOCK_FIRST_SUMMARY);
    expect(body, "the model's reasoning is never shown as the answer").not.toContain(REASONING_MARKER);

    // Latency and throughput of the live call are shown.
    await expect(page.getByTestId("live-latency")).toHaveText(/^\d+(\.\d+)? s of model time$/);
    await expect(page.getByTestId("live-tps")).toHaveText(/^\d+(\.\d+)? tokens\/s$/);

    // The accepted citations open the quoted passage with its page and a link to the source.
    const citations = page.getByTestId("citation");
    await expect(citations).toHaveCount(2);
    await citations.first().click();
    const dialog = page.getByTestId("citation-dialog");
    await expect(dialog).toBeVisible();
    const quote = (await dialog.getByTestId("citation-quote").innerText()).trim();
    expect(quote.split(/\s+/).length).toBeGreaterThanOrEqual(8);
    await expect(dialog.locator("mark")).toHaveCount(1);
    const pageText = await dialog.getByTestId("citation-page").innerText();
    const pdfPage = Number(pageText.replace(/\D+/g, ""));
    const sources = readResult("kb/sources.json");
    const doe = sources.find((s: any) => s.doc === "doe-sourcebook");
    await expect(dialog.getByTestId("citation-link")).toHaveAttribute("href", `${doe.url}#page=${pdfPage}`);
    // The quote really is in the manual chunk for that page.
    const chunks = readResult("kb/chunks.json");
    const squash = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(chunks.some((c: any) => c.doc === "doe-sourcebook" && c.page === pdfPage && squash(c.text).includes(squash(quote)))).toBe(true);
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();

    // The work order came with it; approving is local draft state.
    await expect(page.getByTestId("work-order-title")).toHaveText(MOCK_WORK_ORDER_TITLE);
    await page.getByTestId("wo-approve").click();
    await expect(page.getByTestId("work-order")).toHaveAttribute("data-approved", "1");

    // What the app sent to the model server.
    const log: any[] = await (await request.get(`${MOCK}/__mock/requests`)).json();
    const explains = log.filter((r) => r.response_format?.name === "alarm_explanation");
    expect(explains).toHaveLength(2);
    for (const r of explains) {
      expect(r.reasoning_effort).toBe("low");
      expect(r.response_format).toEqual({ type: "json_schema", name: "alarm_explanation", strict: true, has_schema: true });
      expect(r.model).toBe("openai/gpt-oss-120b");
      expect(r.first_user.startsWith("ALARM EVIDENCE (JSON):\n{")).toBe(true);
      expect(r.first_user).toContain("\n\nREFERENCE EXCERPTS:\n[excerpt 1] doc=doe-sourcebook page=");
    }
    expect(explains[0].roles).toEqual(["system", "user"]);
    expect(explains[1].roles).toEqual(["system", "user", "assistant", "user"]);
    expect(explains[1].last_message).toMatch(/^Your reply was rejected for these reasons:\n- citation 1: the quote does not appear word for word/);
    expect(explains[1].last_message).toMatch(/Correct them and send the complete reply again\.$/);
    // The system prompt is the repo's prompt file, byte for byte (stripped, as Python does).
    const promptFile = readFileSync(path.resolve(RESULTS, "..", "prompts", "explain_system.md"), "utf8").trim();
    expect(explains[0].system).toBe(promptFile);
    const workOrders = log.filter((r) => r.response_format?.name === "work_order");
    expect(workOrders).toHaveLength(1);
    expect(workOrders[0].first_user).toContain("\n\nEXPLANATION (JSON):\n{\"summary\": ");
    const embeds = log.filter((r) => r.path === "/v1/embeddings");
    expect(embeds.length).toBeGreaterThan(0);
    for (const text of embeds.flatMap((r) => r.input)) expect(text.startsWith(QUERY_PREFIX)).toBe(true);

    // Nothing was saved: after a reload the alert is back to "not generated".
    await page.reload();
    await expect(page.getByTestId("explanation")).toHaveAttribute("data-state", "missing");
  });

  test("chat answers a free-form question live, with a citation that opens", async ({ page, request }) => {
    await page.goto(`/alerts/${fixture.liveId}`);
    await expect(page.getByTestId("chat")).toHaveAttribute("data-mode", "live");
    const question = "Where should I look for the leak first?";
    await page.getByTestId("chat-input").fill(question);
    await page.getByTestId("chat-send").click();
    const log = page.getByTestId("chat-log");
    await expect(log.locator(".chat-answer")).toContainText(`${MOCK_ANSWER_PREFIX} "${question}"`, { timeout: 30_000 });
    await expect(page.getByTestId("chat-meta")).toContainText("Answered live");
    await expect(page.locator("body")).not.toContainText(REASONING_MARKER);
    await log.getByTestId("chat-citation").first().click();
    await expect(page.getByTestId("citation-dialog")).toBeVisible();
    await expect(page.getByTestId("citation-dialog").locator(".excerpt")).not.toHaveCount(0);
    await page.getByTestId("citation-dialog").getByRole("button", { name: "Close" }).click();

    const sent: any[] = await (await request.get(`${MOCK}/__mock/requests`)).json();
    const chat = sent.filter((r) => r.path === "/v1/chat/completions");
    expect(chat).toHaveLength(1);
    expect(chat[0].response_format).toBeNull();
    expect(chat[0].reasoning_effort).toBe("low");
    expect(chat[0].max_tokens).toBe(2048);
    expect(chat[0].roles).toEqual(["system", "user", "assistant", "user"]);
    expect(chat[0].last_message).toBe(question);
    expect(chat[0].first_user).toContain("\n\nEXPLANATION (JSON):\nnull\n\nWORK ORDER (JSON):\nnull\n\nREFERENCE EXCERPTS:\n");

    // A follow-up carries the conversation so far.
    await page.getByTestId("chat-input").fill("And after that?");
    await page.getByTestId("chat-send").click();
    await expect(log.locator(".chat-answer")).toHaveCount(2, { timeout: 30_000 });
    const again: any[] = await (await request.get(`${MOCK}/__mock/requests`)).json();
    const second = again.filter((r) => r.path === "/v1/chat/completions")[1];
    expect(second.roles).toEqual(["system", "user", "assistant", "user", "assistant", "user"]);
  });

  test("the chat API validates its input", async ({ request }) => {
    expect((await request.post("/api/chat", { data: { alarm_id: fixture.liveId } })).status()).toBe(400);
    expect((await request.post("/api/chat", { data: { alarm_id: "A99999", question: "x" } })).status()).toBe(404);
    expect((await request.post("/api/explain", { data: { alarm_id: "../../etc/passwd" } })).status()).toBe(400);
    const ok = await request.post("/api/chat", { data: { alarm_id: fixture.liveId, question: "What is going on?", history: [] } });
    expect(ok.status()).toBe(200);
    const json = await ok.json();
    expect(json.answer).toContain(MOCK_ANSWER_PREFIX);
    expect(json.citations[0]).toMatchObject({ doc: "doe-sourcebook" });
    expect(json.citations[0].chunk_ids.length).toBeGreaterThan(0);
    expect(JSON.stringify(json)).not.toContain(REASONING_MARKER);
  });

  test("an alert the pipeline has explained shows the cached explanation, work order and chat answers", async ({ page }) => {
    const after = fixture.after;
    await page.goto(`/alerts/${fixture.afterId}`);
    const explanation = page.getByTestId("explanation");
    await expect(explanation).toHaveAttribute("data-state", "ready");
    await expect(explanation).toHaveAttribute("data-origin", "cached");
    await expect(page.getByTestId("explanation-summary")).toHaveText(after.explanation.summary);
    for (const c of after.explanation.likely_causes) await expect(explanation).toContainText(c.cause);
    for (const a of after.explanation.recommended_actions) await expect(explanation).toContainText(a.action);
    await expect(explanation).toContainText("High confidence");
    await expect(explanation).toContainText("This week");
    await expect(page.getByTestId("explanation-provenance")).toContainText(after.llm.model);
    await expect(page.getByTestId("explanation-provenance")).toContainText(`accepted on attempt ${after.llm.explanation_attempts}`);

    // Citations open the quoted passage, highlighted in the retrieved excerpt.
    const citations = page.getByTestId("citation");
    await expect(citations).toHaveCount(after.explanation.citations.length);
    const dialog = page.getByTestId("citation-dialog");
    for (const [i, c] of after.explanation.citations.entries()) {
      await citations.nth(i).click();
      await expect(dialog.getByTestId("citation-quote")).toHaveText(c.quote);
      await expect(dialog.getByTestId("citation-page")).toContainText(String(c.page));
      await expect(dialog.locator("mark")).toHaveCount(1);
      await expect(dialog.getByTestId("citation-link")).toHaveAttribute("href", c.doc === "doe-sourcebook" ? new RegExp(`#page=${c.page}$`) : /apu_description\.md$/);
      await dialog.getByRole("button", { name: "Close" }).click();
    }

    // Cached chat examples: clicking a question shows its cached answer.
    const examples = page.getByTestId("chat-example");
    await expect(examples).toHaveCount(after.chat_examples.length);
    await examples.first().click();
    const log = page.getByTestId("chat-log");
    await expect(log).toContainText(after.chat_examples[0].question);
    await expect(log.locator(".chat-answer")).toContainText("Synthetic cached answer");
    await expect(page.getByTestId("chat-meta")).toContainText("Cached answer");
    // Its citation points at a chunk that was not among the alert's stored excerpts; it still opens.
    await log.getByTestId("chat-citation").first().click();
    await expect(dialog.locator(".excerpt-id").first()).toBeVisible();
    await expect(dialog.locator(".excerpt-id", { hasText: fixture.chatExtraChunkId })).toHaveCount(1);
    await dialog.getByRole("button", { name: "Close" }).click();

    // Work order: edit, approve and reset are per-browser draft state.
    const wo = page.getByTestId("work-order");
    await expect(page.getByTestId("work-order-title")).toHaveText(after.work_order.title);
    await expect(page.getByTestId("work-order-priority")).toHaveText(after.work_order.priority);
    await expect(wo).toContainText("saved in this browser only");
    await page.getByTestId("wo-edit").click();
    await page.getByTestId("wo-title-input").fill("Edited in the test");
    await page.getByTestId("wo-save").click();
    await expect(page.getByTestId("work-order-title")).toHaveText("Edited in the test");
    await expect(wo).toHaveAttribute("data-edited", "1");
    await page.getByTestId("wo-approve").click();
    await expect(wo).toHaveAttribute("data-approved", "1");
    await page.reload();
    await expect(page.getByTestId("work-order-title")).toHaveText("Edited in the test");
    await expect(page.getByTestId("work-order")).toHaveAttribute("data-approved", "1");
    await page.getByTestId("wo-reset").click();
    await expect(page.getByTestId("work-order-title")).toHaveText(after.work_order.title);
    await expect(page.getByTestId("work-order")).toHaveAttribute("data-approved", "0");
  });

  test("the alerts list and the benchmark pick up the generated fields when they exist", async ({ page }) => {
    await page.goto("/alerts");
    const row = page.locator(`tr[data-alarm-id="${fixture.afterId}"]`);
    await expect(row).toContainText(fixture.after.explanation.summary);
    await expect(row.locator(".chip", { hasText: fixture.after.work_order.priority })).toHaveCount(1);
    await expect(page.locator(`tr[data-alarm-id="${fixture.liveId}"]`)).toContainText("not generated yet");

    await page.goto("/benchmark");
    const llm = fixture.llmSummary;
    const panel = page.getByTestId("llm-summary");
    await expect(panel).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("llm-tps")).toHaveText(String(llm.tokens_per_s.median));
    await expect(page.getByTestId("llm-usd")).toHaveText(`$${llm.usd_per_alert.one_at_a_time}`);
    await expect(panel).toContainText(`$${llm.gpu_price.usd_per_hour} per hour`);
    await expect(panel).toContainText(llm.gpu_price.instance);
    await expect(panel.getByRole("link", { name: "price source" })).toHaveAttribute("href", llm.gpu_price.source);
    await expect(panel).toContainText(llm.model);
  });
});
