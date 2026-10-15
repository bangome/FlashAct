import { chromium } from "playwright";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { PlaywrightAdapter } from "../../src/adapters/playwright/index.js";
import type { CaptchaRecognizer } from "../../src/captcha/ocr.js";
import { JobEngine } from "../../src/core/engine.js";
import { parsePlan } from "../../src/core/schema.js";
import type { JobStatus } from "../../src/core/types.js";
import { captchaFixture, captchaPlan } from "../fixtures/captcha.js";
import { barrier, bounded } from "../fixtures/control-service.js";

async function setup(onRecognition: (image: Uint8Array) => void | Promise<void> = () => {}) {
  const fixture = await captchaFixture();
  try {
    const browser = await chromium.launch({ headless: true });
    let engine: JobEngine | undefined;
    const subscriptions: (() => void)[] = [];
    try {
      const page = await browser.newPage();
      await page.goto(fixture.url);
      await page.locator("#answer").evaluate(node => {
        node.addEventListener("input", () => {
          node.setAttribute("data-inputs", String(Number(node.getAttribute("data-inputs") ?? 0) + 1));
        });
      });
      let preparations = 0;
      let recognitions = 0;
      const ocr: CaptchaRecognizer = {
        prepare: async () => {
          preparations++;
          expect(await page.evaluate(`globalThis.__flashactRuntime.status(${JSON.stringify(plan.jobId)}).state`)).toBe("VALIDATED");
        },
        recognize: async image => {
          recognitions++;
          await onRecognition(image);
          return { text: fixture.answer, confidence: 1 };
        },
        close: async () => {},
      };
      const adapter = new PlaywrightAdapter({ page });
      const ownedEngine = new JobEngine({ adapters: { playwright: adapter }, captchaRecognizer: ocr });
      engine = ownedEngine;
      const [tab] = await ownedEngine.listTabs("playwright");
      if (!tab) throw new Error("No CAPTCHA fixture tab");
      const base = captchaPlan(tab.id, fixture.url);
      if (!base.captcha) throw new Error("Missing fixture CAPTCHA configuration");
      const { submitSelector: _submit, successSelector: _success, ...captcha } = base.captcha;
      const plan = parsePlan({
        ...base, action: { type: "captcha" }, target: { ...base.target, selector: captcha.imageSelector },
        trigger: { type: "ELEMENT_APPEAR", selector: captcha.imageSelector }, captcha,
      });
      function nextStatus(matches: (status: JobStatus) => boolean) {
        const next = barrier<JobStatus>();
        const unsubscribe = ownedEngine.subscribe(status => {
          if (status.jobId === plan.jobId && (matches(status)
            || (status.captcha && ["FAILED", "UNKNOWN", "CANCELLED"].includes(status.captcha.state)))) next.complete(status);
        });
        subscriptions.push(unsubscribe);
        return async () => {
          try { return await bounded(next.promise, "CAPTCHA status"); }
          finally { unsubscribe(); }
        };
      }
      return {
        fixture, page, engine: ownedEngine, adapter, plan, nextStatus,
        counts: () => ({ preparations, recognitions }),
        arm: async () => {
          await ownedEngine.createJob(plan);
          await ownedEngine.validateJob(plan.jobId);
          await ownedEngine.armJob(plan.jobId);
          expect(preparations).toBe(1);
        },
        filled: async (result: JobStatus) => {
          expect(result).toMatchObject({ executions: 1, captcha: { state: "FILLED", inputs: 1, submissions: 0 } });
          expect(result.timing?.clickEpochMs).toBeUndefined();
          expect(recognitions).toBe(1);
          expect(await page.inputValue("#answer")).toBe(fixture.answer);
          expect(await page.getAttribute("#answer", "data-inputs")).toBe("1");
          expect(await page.evaluate("({clicks,submits})")).toEqual({ clicks: 0, submits: 0 });
          expect(fixture.attempts).toEqual([]);
        },
        close: async () => {
          for (const unsubscribe of subscriptions) unsubscribe();
          try { await ownedEngine.close(); }
          finally { try { await browser.close(); } finally { await fixture.close(); } }
        },
      };
    } catch (error) {
      try { await engine?.close(); } finally { await browser.close(); }
      throw error;
    }
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

describe("primary CAPTCHA appearance workflow", { timeout: 30000 }, () => {
  it("waits for a hidden image without OCR until it is revealed", async () => {
    // Given
    const f = await setup();
    const filled = f.nextStatus(status => status.captcha?.state === "FILLED");
    try {
      // When
      await f.arm();
      await f.adapter.wake(f.plan.jobId);
      const waiting = await f.engine.getStatus(f.plan.jobId);
      // Then
      expect(waiting).toMatchObject({ state: "WAITING", executions: 0, captcha: { state: "WAITING", inputs: 0 } });
      expect(f.counts()).toEqual({ preparations: 1, recognitions: 0 });
      expect(await f.page.inputValue("#answer")).toBe("");
      await f.page.locator("#challenge").evaluate(node => { node.removeAttribute("hidden"); });
      await f.filled(await filled());
    } finally { await f.close(); }
  });

  it("accepts an initially absent image inserted after arm", async () => {
    // Given
    const f = await setup();
    const filled = f.nextStatus(status => status.captcha?.state === "FILLED");
    try {
      await f.page.evaluate(`window.savedImage=document.querySelector('#image');
        savedImage.remove();document.querySelector('#challenge').hidden=false;`);
      // When
      await f.arm();
      expect(await f.engine.getStatus(f.plan.jobId)).toMatchObject({ state: "WAITING", executions: 0 });
      expect(f.counts().recognitions).toBe(0);
      await f.page.evaluate("document.querySelector('#challenge').prepend(savedImage)");
      // Then
      await f.filled(await filled());
    } finally { await f.close(); }
  });

  it.each([false, true].flatMap(fixed => [false, true].map(reload => ({ fixed, reload }))))(
    "waits for real PNG load and rejects later reloads: fixed=$fixed reload=$reload", async ({ fixed, reload }) => {
    // Given
    const captured = barrier<Buffer>();
    const f = await setup(async image => {
      captured.complete(Buffer.from(image));
      if (reload) await f.page.locator("#image").evaluate(async node => {
        if (!(node instanceof HTMLImageElement)) throw new Error("Expected loaded fixture image");
        const loaded = new Promise<void>(resolve => node.addEventListener("load", () => resolve(), { once: true }));
        node.src = node.src;
        await loaded;
      });
    });
    const requested = barrier<void>();
    const release = barrier<void>();
    const load = barrier<void>();
    const filled = f.nextStatus(status => status.captcha?.state === "FILLED");
    const imageUrl = `${f.fixture.url}/held.png`;
    try {
      await f.page.locator("#challenge").evaluate(node => { node.removeAttribute("hidden"); });
      const png = await f.page.locator("#image").evaluate(node => {
        if (!(node instanceof HTMLCanvasElement)) throw new Error("Expected fixture canvas");
        return node.toDataURL("image/png").split(",")[1];
      });
      if (!png) throw new Error("Missing fixture PNG");
      const expectedImage = PNG.sync.read(Buffer.from(png, "base64"));
      await f.page.exposeFunction("captchaImageLoaded", () => { load.complete(); });
      await f.page.route(imageUrl, async route => {
        requested.complete();
        await bounded(release.promise, "PNG response release");
        await route.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") });
      });
      await f.page.evaluate("document.querySelector('#image').remove();document.querySelector('#challenge').hidden=false");
      // When
      await f.arm();
      await f.page.evaluate(`
        const image = new Image(${fixed ? "240, 80" : ""});
        image.id = "image";
        image.style.cssText = "display:block;margin:16px 0";
        image.addEventListener("load", () => { void window.captchaImageLoaded(); }, { once: true });
        image.src = ${JSON.stringify(imageUrl)};
        document.querySelector("#challenge").prepend(image);
      `);
      await bounded(requested.promise, "PNG request");
      await f.adapter.wake(f.plan.jobId);
      // Then
      expect(await f.page.locator("#image").evaluate(node => node instanceof HTMLImageElement
        && !node.complete && node.naturalWidth === 0)).toBe(true);
      expect(f.counts().recognitions).toBe(0);
      expect(await f.page.inputValue("#answer")).toBe("");
      release.complete();
      await bounded(load.promise, "PNG load");
      const result = await filled();
      if (reload) {
        expect(result.captcha).toMatchObject({ state: "FAILED", error: "CHALLENGE_CHANGED", inputs: 0, submissions: 0 });
        expect(await f.page.inputValue("#answer")).toBe("");
        expect(f.fixture.attempts).toEqual([]);
      } else await f.filled(result);
      const actualImage = PNG.sync.read(await bounded(captured.promise, "recognized PNG"));
      expect([actualImage.width, actualImage.height]).toEqual([expectedImage.width, expectedImage.height]);
      expect(actualImage.data.some((channel, index) => index % 4 !== 3 && channel < 240)).toBe(true);
    } finally {
      release.complete();
      try { await f.page.unrouteAll({ behavior: "wait" }); } finally { await f.close(); }
    }
  });

  it("cancels before appearance without OCR or input even if the image later appears", async () => {
    // Given
    const f = await setup();
    const cancelled = f.nextStatus(status => status.captcha?.state === "CANCELLED");
    try {
      await f.page.evaluate(`window.savedImage=document.querySelector('#image');
        savedImage.remove();document.querySelector('#challenge').hidden=false;`);
      await f.arm();
      // When
      const result = await f.engine.cancelJob(f.plan.jobId);
      await cancelled();
      await f.page.evaluate("document.querySelector('#challenge').prepend(savedImage)");
      await f.adapter.wake(f.plan.jobId);
      // Then
      expect(result).toMatchObject({ state: "CANCELLED", executions: 0, captcha: { state: "CANCELLED", inputs: 0, submissions: 0 } });
      expect(await f.engine.getStatus(f.plan.jobId)).toMatchObject({ state: "CANCELLED", executions: 0 });
      expect(f.counts().recognitions).toBe(0);
      expect(await f.page.inputValue("#answer")).toBe("");
      expect(await f.page.getAttribute("#answer", "data-inputs")).toBeNull();
      expect(await f.page.evaluate("clicks")).toBe(0);
    } finally { await f.close(); }
  });

  it("does not repeat input or automatically rearm after later mutations", async () => {
    // Given
    const f = await setup();
    const filled = f.nextStatus(status => status.captcha?.state === "FILLED");
    try {
      await f.arm();
      await f.page.locator("#challenge").evaluate(node => { node.removeAttribute("hidden"); });
      await filled();
      // When
      await f.page.locator("#challenge").evaluate(node => new Promise<void>(resolve => {
        const observer = new MutationObserver(() => { observer.disconnect(); resolve(); });
        observer.observe(node, { childList: true, attributes: true, subtree: true });
        node.setAttribute("data-challenge-update", "later");
        node.append(document.createElement("span"));
        const field = node.querySelector("#answer");
        if (!(field instanceof HTMLInputElement)) throw new Error("Expected fixture input");
        field.value = "";
      }));
      await f.adapter.wake(f.plan.jobId);
      // Then
      await expect(f.engine.armJob(f.plan.jobId)).rejects.toMatchObject({ code: "INVALID_STATE" });
      const result = await f.engine.getStatus(f.plan.jobId);
      expect(result).toMatchObject({ executions: 1, captcha: { state: "FILLED", inputs: 1, submissions: 0 } });
      expect(result.timing?.clickEpochMs).toBeUndefined();
      expect(f.counts().recognitions).toBe(1);
      expect(await f.page.inputValue("#answer")).toBe("");
      expect(await f.page.getAttribute("#answer", "data-inputs")).toBe("1");
      expect(await f.page.evaluate("({clicks,submits})")).toEqual({ clicks: 0, submits: 0 });
    } finally { await f.close(); }
  });
});
