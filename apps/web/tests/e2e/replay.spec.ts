import { expect, test } from "@playwright/test";
import { expectedLead, readResult, resultExists, wallToEpoch } from "./helpers";

// Replay mode against the real pipeline results. Every expected value below is read
// from results/ at test time: no alarm id, count or figure is written in this file.

const alarms: any[] = readResult("alarms.json").alarms;
const bench = readResult("bench.json");
const manifest = readResult("replay/manifest.json");
const f2 = alarms.find((a) => a.attribution === "F2");

test.describe("replay mode", () => {
  test("status says replay and makes no claim about the droplet", async ({ request, page }) => {
    const status = await (await request.get("/api/status")).json();
    expect(status.mode).toBe("replay");
    expect(status.live_configured).toBe(false);
    expect(status.droplet_reachable).toBeNull();
    await page.goto("/");
    await expect(page.getByTestId("mode-badge")).toHaveAttribute("data-mode", "replay");
    await expect(page.getByTestId("mode-badge")).toContainText("Replay");
  });

  test("live-only API routes refuse in replay mode with a clear JSON error", async ({ request }) => {
    for (const [route, body] of [
      ["/api/chat", { alarm_id: f2.id, question: "What should I check first?", history: [] }],
      ["/api/explain", { alarm_id: f2.id }],
    ] as const) {
      const resp = await request.post(route, { data: body });
      expect(resp.status(), route).toBe(409);
      const json = await resp.json();
      expect(json.mode).toBe("replay");
      expect(json.error).toMatch(/replay mode/i);
    }
  });

  test("replays through failure F2: the alarm appears only once the clock reaches it, then its alert and the benchmark", async ({ page }) => {
    expect(f2, "results/alarms.json has an alarm credited to F2").toBeTruthy();
    const fire = wallToEpoch(f2.fire);

    await page.goto("/");
    await expect(page.locator(".plant")).toHaveAttribute("data-ready", "1");
    const clock = page.getByTestId("clock");
    const feedItem = page.locator(`[data-testid="feed-item"][data-alarm-id="${f2.id}"]`);
    const timelineMark = page.locator(`[data-testid="timeline"] [data-method="faultline"][data-alarm-id="${f2.id}"]`);

    // Jump to shortly before F2: the clock is before the alarm's fire time and the alarm is nowhere.
    await page.getByTestId("jump-F2").click();
    await expect.poll(async () => Number(await clock.getAttribute("data-epoch"))).toBeGreaterThan(fire - 12 * 3600);
    const jumped = Number(await clock.getAttribute("data-epoch"));
    expect(jumped).toBeLessThan(fire);
    await expect(feedItem).toHaveCount(0);
    await expect(timelineMark).toHaveCount(0);
    // Earlier alarms are already there, and every one of them fired before the clock.
    const shown = await page.locator('[data-testid="feed-item"][data-method="faultline"]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.alarmId));
    expect(shown.sort()).toEqual(alarms.filter((a) => wallToEpoch(a.fire) <= jumped).map((a) => a.id).sort());

    // Watch every frame: record the clock the first time the alarm is on the page.
    await page.evaluate((id) => {
      const w = window as any;
      w.__firstSeen = null;
      const check = () => {
        const epoch = Number((document.querySelector('[data-testid="clock"]') as HTMLElement).dataset.epoch);
        const there = document.querySelector(`[data-alarm-id="${id}"][data-method="faultline"]`);
        if (there && w.__firstSeen === null) w.__firstSeen = epoch;
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    }, f2.id);

    // Play at high speed until it fires.
    await page.locator('[data-speed="21600"]').click();
    await page.getByTestId("play").click();
    await expect(feedItem).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("play").click();
    const firstSeen = await page.evaluate(() => (window as any).__firstSeen);
    expect(firstSeen, "the alarm was never shown before its fire time").toBeGreaterThanOrEqual(fire);
    await expect(timelineMark).toHaveCount(1);
    await expect(page.getByTestId("state")).toContainText(f2.id);

    // The charts hold data up to the clock and nothing after it.
    const scorePlot = page.getByTestId("chart-score").locator(".uplot");
    await expect(scorePlot).toHaveAttribute("data-points", /^[1-9]\d*$/);
    await expect(page.getByTestId("chart-score").locator("canvas")).toBeVisible();
    await expect(page.getByTestId("chart-pressure").locator("canvas")).toBeVisible();

    // Follow the alarm to its alert view.
    await feedItem.locator("a").click();
    await expect(page).toHaveURL(new RegExp(`/alerts/${f2.id}$`));
    await expect(page.getByTestId("alert-view")).toHaveAttribute("data-alarm-id", f2.id);
    await expect(page.getByTestId("alarm-chart")).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("alarm-chart-score").locator(".uplot")).toHaveAttribute("data-points", /^[1-9]\d*$/);
    await expect(page.getByTestId("alarm-chart-score").locator("canvas")).toBeVisible();

    const alert = readResult(`alerts/${f2.id}.json`);
    const detector = alert.evidence.detector;
    const score = page.getByTestId("evidence-score");
    await expect(score.locator(`[data-value="${detector.score_at_alarm}"]`)).toHaveText(String(detector.score_at_alarm));
    await expect(score.locator(`[data-value="${detector.threshold}"]`)).toHaveText(String(detector.threshold));
    await expect(page.getByTestId("evidence-signals").locator("tbody tr")).toHaveCount(Object.keys(alert.evidence.signals).length);
    await expect(page.getByTestId("evidence-duty")).toBeVisible();
    const shares = page.getByTestId("error-shares").locator("li");
    await expect(shares).toHaveCount(alert.alarm.top_signals.length);
    await expect(shares.first()).toHaveAttribute("data-signal", alert.alarm.top_signals[0].signal);
    await expect(shares.first().locator(".share-value")).toHaveAttribute("data-value", String(alert.alarm.top_signals[0].share));

    // Explanation: whatever the pipeline has (or has not) produced, shown as such.
    if (alert.explanation) {
      await expect(page.getByTestId("explanation-summary")).toHaveText(alert.explanation.summary);
      await expect(page.getByTestId("work-order-title")).toHaveText(alert.work_order.title);
    } else {
      await expect(page.getByTestId("explanation")).toHaveAttribute("data-state", "missing");
      await expect(page.getByTestId("explanation-missing")).toContainText("Not generated yet");
      await expect(page.getByTestId("work-order")).toHaveAttribute("data-state", "missing");
    }
    // Replay mode: no free-form chat, and it says why.
    await expect(page.getByTestId("chat-input")).toBeDisabled();
    await expect(page.getByTestId("chat-replay-note")).toContainText("need live mode");
    await expect(page.getByTestId("chat-example")).toHaveCount((alert.chat_examples ?? []).length);
    await expect(page.getByTestId("regenerate")).toHaveCount(0);

    // Benchmark: figures on the page equal the values in results/bench.json.
    await page.goto("/benchmark");
    const summary = page.getByTestId("summary-table");
    for (const m of bench.methods) {
      const cell = (field: string) => summary.locator(`td[data-method="${m.key}"][data-field="${field}"]`);
      await expect(cell("failures_detected")).toHaveText(`${m.summary.failures_detected} of ${m.failures.length}`);
      await expect(cell("false_alarms")).toHaveText(String(m.summary.false_alarms));
      await expect(cell("false_alarms_per_week")).toHaveText(m.summary.false_alarms_per_week.toFixed(2));
      await expect(cell("false_alarms_per_week")).toHaveAttribute("data-value", String(m.summary.false_alarms_per_week));
      await expect(cell("false_alarms_per_observed_week")).toHaveText(m.summary.false_alarms_per_observed_week.toFixed(2));
      await expect(cell("false_alarms_during_sustained_load")).toHaveText(String(m.summary.false_alarms_during_sustained_load));
      await expect(cell("alarms_in_tuning_period")).toHaveText(String(m.summary.alarms_in_tuning_period));
      for (const f of m.failures) {
        const lead = page.getByTestId("lead-table").locator(`td[data-method="${m.key}"][data-failure="${f.id}"]`);
        await expect(lead.locator("strong")).toHaveText(expectedLead(f.lead_before_start_h, f.detected));
        await expect(lead).toHaveAttribute("data-detected", f.detected ? "1" : "0");
        // A missed failure has no mark on the chart; a detected one sits at its lead.
        const mark = page.getByTestId("lead-chart").locator(`g[data-method="${m.key}"][data-failure="${f.id}"]`);
        if (f.detected) await expect(mark).toHaveAttribute("data-lead", String(f.lead_before_start_h));
        else await expect(mark).toHaveAttribute("data-missed", "1");
        if (f.maintenance) {
          const warn = page.getByTestId("maintenance-table").locator(`td[data-method="${m.key}"][data-failure="${f.id}"]`);
          await expect(warn).toHaveText(f.lead_before_maintenance_h === null ? "no alarm" : `${f.lead_before_maintenance_h.toFixed(1)} h before`);
        }
      }
    }
    for (const [h, row] of Object.entries<any>(bench.sensitivity.lead_horizon_h)) {
      for (const m of bench.methods) {
        const cell = page.getByTestId("sensitivity-table").locator(`td[data-method="${m.key}"][data-horizon="${h}"]`);
        await expect(cell).toHaveText(`${row[m.key].failures_detected} of ${m.failures.length}, ${row[m.key].false_alarms_per_week.toFixed(2)}`);
      }
    }

    // Where it was trained: exactly what bench.json says, and no MI300X claim unless it is true.
    const training = bench.training;
    await expect(page.getByTestId("trained-on")).toHaveAttribute("data-mi300x", training.trained_on_mi300x ? "1" : "0");
    await expect(page.getByTestId("trained-device")).toContainText(String(training.hardware.device));
    if (!training.trained_on_mi300x) {
      await expect(page.getByTestId("trained-on")).toHaveText("not trained on the MI300X");
      await expect(page.getByTestId("trained-device")).toContainText("not the MI300X");
    }
    await expect(page.getByTestId("train-seconds")).toHaveAttribute("data-value", String(training.train_seconds_total));
    await expect(page.getByTestId("train-seconds")).toContainText(Math.round(training.train_seconds_total).toLocaleString("en-US"));

    // LLM throughput and cost: from results/llm/summary.json, or an honest empty state.
    if (resultExists("llm/summary.json")) {
      const llm = readResult("llm/summary.json");
      await expect(page.getByTestId("llm-tps")).toHaveText(String(llm.tokens_per_s.median));
    } else {
      await expect(page.getByTestId("llm-summary")).toHaveAttribute("data-state", "missing");
      await expect(page.getByTestId("llm-summary-missing")).toContainText("Not measured yet");
    }
  });

  test("the alerts list shows every alarm with its outcome", async ({ page }) => {
    await page.goto("/alerts");
    const rows = page.getByTestId("alerts-table").locator("tbody tr");
    await expect(rows).toHaveCount(alarms.length);
    for (const a of alarms) {
      const row = page.locator(`tr[data-alarm-id="${a.id}"]`);
      await expect(row).toHaveAttribute("data-attribution", a.attribution);
      await expect(row).toContainText(a.fire.slice(0, 16));
      if (/^F\d+$/.test(a.attribution)) await expect(row).toContainText(`Credited to failure ${a.attribution}`);
      if (a.attribution === "false_alarm") await expect(row).toContainText("False alarm");
      if (a.attribution === "tuning_period") await expect(row).toContainText("Tuning period");
      await expect(row.getByText("sustained load")).toHaveCount(a.during_sustained_load ? 1 : 0);
    }
  });

  test("a deep link opens the replay at that moment, paused, with only the alarms fired by then", async ({ page }) => {
    const t = wallToEpoch(f2.fire) + 600;
    await page.goto(`/?t=${t}`);
    await expect(page.getByTestId("clock")).toHaveAttribute("data-epoch", String(t));
    await expect(page.getByTestId("clock")).toContainText(f2.fire.slice(0, 10));
    const expected = manifest.alarms.faultline.filter((a: any) => a.fire <= t).length;
    await expect(page.locator('[data-testid="feed-item"][data-method="faultline"]')).toHaveCount(expected);
    if (wallToEpoch(f2.end) > t) await expect(page.getByTestId("state")).toContainText(`Alarm active: ${f2.id}`);
    // Overlaying a static-threshold method adds exactly its alarms fired by then, and no later ones.
    const staticFired = manifest.alarms.static_tuned.filter((a: any) => a.fire <= t);
    await expect(page.locator('[data-testid="timeline"] [data-method="static_tuned"]')).toHaveCount(0);
    await page.getByTestId("overlay-static_tuned").check();
    await expect(page.locator('[data-testid="timeline"] [data-method="static_tuned"]')).toHaveCount(staticFired.length);
    if (staticFired.length) {
      const newest = staticFired[staticFired.length - 1];
      await expect(page.locator(`[data-testid="feed-item"][data-method="static_tuned"][data-alarm-id="${newest.id}"]`)).toHaveCount(1);
    }
  });

  test("the plant view fits a phone without sideways scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?t=${wallToEpoch(f2.fire) + 600}`);
    await expect(page.locator(".plant")).toHaveAttribute("data-ready", "1");
    await expect(page.getByTestId("chart-score").locator("canvas")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
