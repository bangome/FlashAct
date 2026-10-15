import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PlaywrightAdapter } from "../../src/adapters/playwright/index.js";
import { JobEngine } from "../../src/core/engine.js";
import { parsePlan } from "../../src/core/schema.js";
import type { JobStatus } from "../../src/core/types.js";
import type { CaptchaRecognition } from "../../src/captcha/ocr.js";
import { captchaFixture } from "../fixtures/captcha.js";
import { barrier, bounded } from "../fixtures/control-service.js";

let browser: Browser | undefined;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 30000);
afterAll(async () => { await browser?.close(); });

async function setup(holdRecognition = false) {
  const fixture = await captchaFixture({ externalAppearance: true, ordinaryBeforeCaptcha: true });
  try {
    if (!browser) throw new Error("Screen fixture browser was not initialized");
    const context = await browser.newContext();
    let engine: JobEngine | undefined;
    let unsubscribe = () => {};
    const release = barrier<CaptchaRecognition>();
    try {
      const page = await context.newPage();
      await page.goto(fixture.url);
      await page.evaluate(epoch => { Date.now = () => epoch; }, Date.now());
      const started = barrier<void>();
      const recognize = vi.fn(async () => {
        started.complete();
        return holdRecognition ? bounded(release.promise, "held screen OCR")
          : { text: fixture.answer, confidence: 1 };
      });
      const adapter = new PlaywrightAdapter({ page });
      const capture = vi.spyOn(adapter, "capture");
      const owned = new JobEngine({ adapters: { playwright: adapter }, captchaRecognizer: {
        prepare: async () => {}, recognize, close: async () => {},
      } });
      engine = owned;
      const [tab] = await owned.listTabs("playwright");
      if (!tab) throw new Error("Missing screen fixture tab");
      const plan = parsePlan({
        schemaVersion: "1.0", jobId: randomUUID(), name: "Screen regression", backend: "playwright",
        target: { tabId: tab.id, selector: "#reserve", url: fixture.url },
        trigger: { type: "ELEMENT_ENABLE", selector: "#reserve" }, action: { type: "click" },
        timezone: "UTC", expiresAt: Date.now() + 60000, maxExecutions: 1,
        verification: { timeoutMs: 5000 }, guards: { approvedUrl: fixture.url, allowIrreversible: false },
        captcha: { screenSelector: "#challenge", imageSelector: "#image", inputSelector: "#answer",
          submitSelector: "#submit", successSelector: "#success", timeoutMs: 1000 },
      });
      const completed = barrier<JobStatus>();
      unsubscribe = owned.subscribe(status => {
        if (status.jobId === plan.jobId && status.captcha
          && ["VERIFIED", "FAILED", "UNKNOWN", "CANCELLED"].includes(status.captcha.state)) completed.complete(status);
      });
      return {
        fixture, page, adapter, engine: owned, plan, capture, recognize, release, started,
        outcome: () => bounded(completed.promise, "screen CAPTCHA outcome"),
        arm: async (input = plan) => {
          await owned.createJob(input); await owned.validateJob(input.jobId); await owned.armJob(input.jobId);
        },
        waiting: async () => {
          const view = await page.evaluate(async () => {
            const bridges = globalThis.__flashactCaptchas;
            if (bridges?.size !== 1) throw new Error("Expected one owned CAPTCHA bridge");
            const [bridge] = bridges.values();
            if (!bridge) throw new Error("Missing owned CAPTCHA bridge");
            return bridge.read(0);
          });
          expect(view).toMatchObject({ state: "waiting", inputs: 0, submissions: 0 });
          expect(capture).not.toHaveBeenCalled();
          expect(recognize).not.toHaveBeenCalled();
          expect(await page.evaluate("({clicks,inputs,submits})")).toEqual({ clicks: 1, inputs: 0, submits: 0 });
        },
        close: async () => {
          release.complete({ text: "", confidence: 0 }); unsubscribe();
          try { await owned.close(); }
          finally { capture.mockRestore(); try { await context.close(); } finally { await fixture.close(); } }
        },
      };
    } catch (error) {
      release.complete({ text: "", confidence: 0 }); unsubscribe();
      try { await engine?.close(); } finally { await context.close(); }
      throw error;
    }
  } catch (error) { await fixture.close(); throw error; }
}

describe("CAPTCHA screen containment", { timeout: 30000 }, () => {
  it.each(["absent", "hidden", "unready"])("ignores the ordinary form until the %s screen is confirmed", async state => {
    // Given: matching fields are visible outside the unconfirmed screen.
    const f = await setup();
    try {
      if (state === "absent") await f.page.evaluate(`
        window.savedScreen=document.querySelector('#challenge');savedScreen.remove();
        const show=window.showChallenge;
        window.showChallenge=()=>{document.querySelector('main').append(savedScreen);show();};
      `);
      if (state === "unready") await f.page.locator("#challenge").evaluate(node => {
        node.removeAttribute("hidden"); node.setAttribute("style", "height:1px");
      });
      expect(await f.page.locator("#image").isVisible()).toBe(true);
      expect(await f.page.locator("#answer").isVisible()).toBe(true);
      expect(await f.page.locator("#submit").isVisible()).toBe(true);
      await f.arm();
      await f.waiting();
      // When: the external fixture moves the fields into the confirmed screen.
      if (state === "unready") await f.page.locator("#challenge").evaluate(node => {
        const replacement = document.createElement("section");
        replacement.id = node.id; replacement.hidden = true; node.replaceWith(replacement);
      });
      await f.fixture.reveal();
      const result = await f.outcome();
      // Then: the original click and CAPTCHA submission each happen once.
      expect(result).toMatchObject({ executions: 1, captcha: { state: "VERIFIED", inputs: 1, submissions: 1 } });
      expect(f.recognize).toHaveBeenCalledTimes(1);
      expect(f.capture).toHaveBeenCalledTimes(2);
      expect(await f.page.inputValue("#answer")).toBe(f.fixture.answer);
      expect(await f.page.evaluate("({clicks,imageClicks,inputs,submits})"))
        .toEqual({ clicks: 1, imageClicks: 0, inputs: 1, submits: 1 });
      expect(f.fixture.attempts).toEqual([f.fixture.answer]);
      await expect(f.engine.armJob(f.plan.jobId)).rejects.toMatchObject({ code: "INVALID_STATE" });
    } finally { await f.close(); }
  });

  it("starts the processing deadline only after screen readiness when the click was long ago", async () => {
    // Given
    const f = await setup();
    const epoch = Date.now();
    try {
      await f.page.evaluate(epoch => { Date.now = () => epoch; }, epoch);
      await f.arm();
      // When: browser time exceeds the processing timeout before the screen appears.
      await f.page.evaluate(epoch => { Date.now = () => epoch; }, epoch + 1001);
      await f.waiting();
      await f.page.evaluate("showChallenge()");
      // Then
      expect((await f.outcome()).captcha).toMatchObject({ state: "VERIFIED", inputs: 1, submissions: 1 });
      expect(f.recognize).toHaveBeenCalledTimes(1);
      expect(f.fixture.attempts).toEqual([f.fixture.answer]);
      expect(await f.page.evaluate("clicks")).toBe(1);
    } finally { await f.close(); }
  });

  it("cancels a never-confirmed screen without capturing the ordinary form", async () => {
    // Given
    const f = await setup();
    try {
      await f.arm(); await f.waiting();
      // When
      await f.engine.cancelJob(f.plan.jobId);
      const result = await f.outcome();
      await f.page.evaluate("showChallenge()");
      // Then
      expect(result.captcha).toMatchObject({ state: "CANCELLED", inputs: 0, submissions: 0 });
      expect(f.capture).not.toHaveBeenCalled();
      expect(f.recognize).not.toHaveBeenCalled();
      expect(await f.page.inputValue("#answer")).toBe("");
      expect(await f.page.evaluate("({clicks,inputs,submits})")).toEqual({ clicks: 1, inputs: 0, submits: 0 });
      expect(f.fixture.attempts).toEqual([]);
    } finally { await f.close(); }
  });

  it("bounds the pre-screen wait by plan expiry without OCR", async () => {
    // Given
    const f = await setup();
    try {
      await f.arm(); await f.waiting();
      // When: browser time passes plan expiry; the existing reader lease observes it.
      await f.page.evaluate(epoch => {
        Date.now = () => epoch;
      }, f.plan.expiresAt + 1);
      // Then
      expect((await f.outcome()).captcha).toMatchObject({ state: "FAILED", error: "TIMEOUT", inputs: 0, submissions: 0 });
      expect(f.capture).not.toHaveBeenCalled();
      expect(f.recognize).not.toHaveBeenCalled();
      expect(await f.page.inputValue("#answer")).toBe("");
    } finally { await f.close(); }
  });

  it.each(["hidden", "removed", "replaced", "input moved"])("rejects a screen %s during held recognition", async change => {
    // Given: the original screen identity is established by an actual capture.
    const f = await setup(true);
    try {
      await f.arm();
      await f.page.evaluate("showChallenge()");
      await bounded(f.started.promise, "screen OCR start");
      expect(f.capture).toHaveBeenCalledTimes(1);
      // When: the screen contract is lost while OCR is outstanding.
      await f.page.locator("#challenge").evaluate((node, change) => {
        switch (change) {
          case "hidden": node.setAttribute("hidden", ""); break;
          case "removed": node.remove(); break;
          case "replaced": {
            const replacement = document.createElement("section");
            replacement.id = node.id;
            replacement.append(...node.childNodes);
            node.replaceWith(replacement);
            break;
          }
          case "input moved": {
            const input = node.querySelector("#answer");
            if (!input) throw new Error("Missing held input");
            document.body.append(input);
            break;
          }
          default: throw new Error(`Unexpected screen mutation: ${change}`);
        }
      }, change);
      f.release.complete({ text: f.fixture.answer, confidence: 1 });
      // Then
      expect((await f.outcome()).captcha).toMatchObject({ state: "FAILED", error: "CHALLENGE_CHANGED", inputs: 0, submissions: 0 });
      expect(f.recognize).toHaveBeenCalledTimes(1);
      expect(await f.page.evaluate("({clicks,inputs,submits})")).toEqual({ clicks: 1, inputs: 0, submits: 0 });
      if (change !== "removed") expect(await f.page.inputValue("#answer")).toBe("");
      expect(f.fixture.attempts).toEqual([]);
    } finally { await f.close(); }
  });

  it.each(["body", "html", "#challenge, main"])("rejects the invalid screen selector %s", async screenSelector => {
    // Given
    const f = await setup();
    try {
      await f.page.evaluate("showChallenge()");
      const plan = parsePlan({ ...f.plan, captcha: { ...f.plan.captcha, screenSelector } });
      // When
      await f.arm(plan);
      // Then
      expect((await f.outcome()).captcha).toMatchObject({ state: "FAILED", error: "GUARD_REJECTED", inputs: 0, submissions: 0 });
      expect(f.capture).not.toHaveBeenCalled();
      expect(f.recognize).not.toHaveBeenCalled();
      expect(await f.page.inputValue("#answer")).toBe("");
      expect(f.fixture.attempts).toEqual([]);
    } finally { await f.close(); }
  });

  it("rejects a CAPTCHA plan without a screen selector at the parse boundary", async () => {
    // Given
    const f = await setup();
    try {
      const captcha = { imageSelector: "#image", inputSelector: "#answer" };
      // When / Then
      expect(() => parsePlan({ ...f.plan, captcha })).toThrow(expect.objectContaining({ code: "INVALID_PLAN" }));
      expect(f.capture).not.toHaveBeenCalled();
      expect(f.recognize).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("does not start OCR if the confirmed screen disappears during capture", async () => {
    // Given: preserve the real screenshot, then simulate the screen closing.
    const f = await setup();
    f.capture.mockImplementationOnce(async (tabId, region) => {
      const image = await PlaywrightAdapter.prototype.capture.call(f.adapter, tabId, region);
      await f.page.locator("#challenge").evaluate(node => node.setAttribute("hidden", ""));
      return image;
    });
    try {
      await f.arm();
      // When
      await f.page.evaluate("showChallenge()");
      // Then
      expect((await f.outcome()).captcha).toMatchObject({ state: "FAILED", error: "CHALLENGE_CHANGED", inputs: 0 });
      expect(f.capture).toHaveBeenCalledTimes(1);
      expect(f.recognize).not.toHaveBeenCalled();
      expect(f.fixture.attempts).toEqual([]);
    } finally { await f.close(); }
  });
});
