import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { PlaywrightAdapter } from "../../src/adapters/playwright/index.js";
import { JobEngine } from "../../src/core/engine.js";
import { parsePlan } from "../../src/core/schema.js";
import type { JobStatus } from "../../src/core/types.js";
import { captchaFixture, captchaPlan } from "../fixtures/captcha.js";
import { barrier, bounded } from "../fixtures/control-service.js";

describe("CAPTCHA ancestor readiness", { timeout: 30000 }, () => {
  it.each(["opacity", "visibility"])("fills after a higher ancestor changes %s without a wake", async hiding => {
    // Given
    const fixture = await captchaFixture();
    try {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(fixture.url);
        await page.locator("#challenge").evaluate(node => { node.removeAttribute("hidden"); });
        await page.locator("main").evaluate((node, property) => {
          node.setAttribute("style", property === "opacity" ? "opacity:0" : "visibility:hidden");
        }, hiding);
        const engine = new JobEngine({ adapters: { playwright: new PlaywrightAdapter({ page }) },
          captchaRecognizer: { prepare: async () => {}, close: async () => {},
            recognize: async () => ({ text: fixture.answer, confidence: 1 }) } });
        const completed = barrier<JobStatus>();
        const unsubscribe = engine.subscribe(status => {
          if (status.captcha && ["FILLED", "FAILED", "UNKNOWN", "CANCELLED"].includes(status.captcha.state))
            completed.complete(status);
        });
        try {
          const [tab] = await engine.listTabs("playwright");
          if (!tab) throw new Error("Missing authored tab");
          const base = captchaPlan(tab.id, fixture.url);
          const plan = parsePlan({ ...base, action: { type: "captcha" },
            target: { ...base.target, selector: "#image" },
            trigger: { type: "ELEMENT_APPEAR", selector: "#image" },
            captcha: { screenSelector: "#challenge", imageSelector: "#image", inputSelector: "#answer" } });
          await engine.createJob(plan); await engine.validateJob(plan.jobId); await engine.armJob(plan.jobId);
          // Drain initial resize delivery before the visibility-only mutation.
          await page.locator("#image").evaluate(node => new Promise<void>(resolve => {
            const observer = new ResizeObserver(() => { observer.disconnect(); resolve(); });
            observer.observe(node);
          }));
          expect(await engine.getStatus(plan.jobId)).toMatchObject({ state: "WAITING", executions: 0 });
          // When: a separate observer acknowledges delivery; it never wakes the job.
          await page.locator("main").evaluate(node => new Promise<void>(resolve => {
            const observer = new MutationObserver(() => { observer.disconnect(); resolve(); });
            observer.observe(node, { attributes: true });
            node.removeAttribute("style");
          }));
          // Then
          expect(await engine.getStatus(plan.jobId)).toMatchObject({ state: "VERIFIED", executions: 1 });
          const result = await bounded(completed.promise, "ancestor CAPTCHA input");
          expect(result.captcha).toMatchObject({ state: "FILLED", inputs: 1, submissions: 0 });
          expect(result.timing?.clickEpochMs).toBeUndefined();
          expect(await page.inputValue("#answer")).toBe(fixture.answer);
          expect(await page.evaluate("({clicks,imageClicks,inputs,submits})"))
            .toEqual({ clicks: 0, imageClicks: 0, inputs: 1, submits: 0 });
        } finally { unsubscribe(); await engine.close(); }
      } finally { await browser.close(); }
    } finally { await fixture.close(); }
  });
});
