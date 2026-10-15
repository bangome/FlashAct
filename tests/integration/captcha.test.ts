import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { JobEngine } from "../../src/core/engine.js";
import { PlaywrightAdapter } from "../../src/adapters/playwright/index.js";
import { VisionRecognizer } from "../../src/captcha/ocr.js";
import type { CaptchaRecognizer, CaptchaRecognition } from "../../src/captcha/ocr.js";
import { captchaFixture, captchaOutcome, captchaPlan } from "../fixtures/captcha.js";
import { parsePlan } from "../../src/core/schema.js";

function recognizer(recognize: CaptchaRecognizer["recognize"]): CaptchaRecognizer {
  return { prepare: async () => {}, recognize, close: async () => {} };
}
async function setup(ocr: CaptchaRecognizer) {
  const fixture = await captchaFixture();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(fixture.url);
  const adapter = new PlaywrightAdapter({ page });
  const engine = new JobEngine({ adapters: { playwright: adapter }, captchaRecognizer: ocr });
  const tabs = await engine.listTabs("playwright");
  const tab = tabs[0];
  if (!tab) throw new Error("No fixture tab");
  const plan = captchaPlan(tab.id, fixture.url);
  const outcome = captchaOutcome(engine);
  return { fixture, browser, page, engine, plan, outcome, close: async () => {
    outcome.dispose();
    try { await engine.close(); } finally { await browser.close(); await fixture.close(); }
  } };
}

// The workflow permits 15 seconds plus browser startup; this is not a 5s latency test.
describe("captcha post-click workflow", { timeout: 30000 }, () => {
  it("captures pixels, fills once, submits once and observes an independent receipt", async () => {
    // Given
    const f = await setup(recognizer(async image => {
      expect(Buffer.from(image).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      return { text: "K7M2X9", confidence: 0.99 };
    }));
    try {
      // When
      await f.engine.createJob(f.plan); await f.engine.validateJob(f.plan.jobId); await f.engine.armJob(f.plan.jobId);
      const result = await f.outcome.result;
      // Then
      expect(result).toMatchObject({ executions: 1, captcha: { state: "VERIFIED", inputs: 1, submissions: 1 } });
      expect(f.fixture.attempts).toEqual([f.fixture.answer]);
      expect(await f.page.evaluate("({clicks,submits,receiptStatus})")).toEqual({ clicks: 1, submits: 1, receiptStatus: 200 });
      await expect(f.engine.armJob(f.plan.jobId)).rejects.toMatchObject({ code: "INVALID_STATE" });
    } finally { await f.close(); }
  });

  it("does not input a low-confidence OCR result", async () => {
    // Given
    const f = await setup(recognizer(async () => ({ text: "K7M2X9", confidence: 0.1 })));
    try {
      // When
      await f.engine.createJob(f.plan); await f.engine.validateJob(f.plan.jobId); await f.engine.armJob(f.plan.jobId);
      const result = await f.outcome.result;
      // Then
      expect(result.captcha).toMatchObject({ state: "FAILED", error: "LOW_CONFIDENCE", inputs: 0, submissions: 0 });
      expect(await f.page.inputValue("#answer")).toBe("");
      expect(f.fixture.attempts).toEqual([]);
    } finally { await f.close(); }
  });

  it("rejects pixels changed during recognition even when canvas identity is unchanged", async () => {
    // Given
    let began = () => {};
    let finish: (result: CaptchaRecognition) => void = () => {};
    const started = new Promise<void>(resolve => { began = resolve; });
    const held = new Promise<CaptchaRecognition>(resolve => { finish = resolve; });
    const f = await setup(recognizer(async () => { began(); return held; }));
    try {
      await f.engine.createJob(f.plan); await f.engine.validateJob(f.plan.jobId);
      // When
      await f.engine.armJob(f.plan.jobId); await started;
      await f.page.evaluate("drawChallenge('Z8N3Y4')");
      finish({ text: "K7M2X9", confidence: 0.99 });
      const result = await f.outcome.result;
      // Then
      expect(result.captcha).toMatchObject({ state: "FAILED", error: "CHALLENGE_CHANGED", inputs: 0, submissions: 0 });
      expect(await f.page.inputValue("#answer")).toBe("");
      expect(f.fixture.attempts).toEqual([]);
    } finally { finish({ text: "", confidence: 0 }); await f.close(); }
  });

  it("cancels recognition through the exact abort event without entering text", async () => {
    // Given
    let began = () => {};
    const started = new Promise<void>(resolve => { began = resolve; });
    const f = await setup(recognizer((_image, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true });
      began();
    })));
    try {
      await f.engine.createJob(f.plan); await f.engine.validateJob(f.plan.jobId);
      // When
      await f.engine.armJob(f.plan.jobId); await started;
      await f.engine.cancelJob(f.plan.jobId);
      const result = await f.outcome.result;
      // Then
      expect(result.captcha).toMatchObject({ state: "CANCELLED", inputs: 0, submissions: 0 });
      expect(await f.page.inputValue("#answer")).toBe("");
      expect(f.fixture.attempts).toEqual([]);
    } finally { await f.close(); }
  });

  it("cancels before the scheduled click without starting OCR or clicking", async () => {
    // Given
    let recognitions = 0;
    const f = await setup(recognizer(async () => { recognitions++; return { text: "K7M2X9", confidence: 1 }; }));
    const plan = parsePlan({ ...f.plan, trigger: { type: "SCHEDULED", at: Date.now() + 30000 } });
    try {
      await f.engine.createJob(plan); await f.engine.validateJob(plan.jobId);
      // When
      await f.engine.armJob(plan.jobId);
      await f.engine.cancelJob(plan.jobId);
      const result = await f.outcome.result;
      // Then
      expect(result.captcha).toMatchObject({ state: "CANCELLED", inputs: 0, submissions: 0 });
      expect(recognitions).toBe(0);
      expect(await f.page.evaluate("clicks")).toBe(0);
      expect(f.fixture.attempts).toEqual([]);
    } finally { await f.close(); }
  });

  it("keeps a submitted but unverified captcha UNKNOWN without submitting again", async () => {
    // Given
    const f = await setup(recognizer(async () => ({ text: "K7M2X9", confidence: 1 })));
    const plan = parsePlan({ ...f.plan, captcha: { ...f.plan.captcha, timeoutMs: 1000, successSelector: "#never" } });
    // Control the browser deadline, not screenshot or network speed.
    await f.page.evaluate("window.captchaClock=Date.now();Date.now=()=>window.captchaClock");
    let submitted = () => {};
    const dispatched = new Promise<void>(resolve => { submitted = resolve; });
    const unsubscribe = f.engine.subscribe(status => {
      if (status.captcha?.state === "SUBMITTED") submitted();
    });
    try {
      await f.engine.createJob(plan); await f.engine.validateJob(plan.jobId);
      // When
      await f.engine.armJob(plan.jobId);
      await dispatched;
      await f.page.evaluate("window.captchaClock+=1001;document.dispatchEvent(new CustomEvent('__flashact_status__'))");
      const result = await f.outcome.result;
      // Then
      expect(result.captcha).toMatchObject({ state: "UNKNOWN", error: "TIMEOUT", inputs: 1, submissions: 1 });
      expect(f.fixture.attempts).toEqual([f.fixture.answer]);
      await f.engine.getStatus(plan.jobId);
      expect(await f.page.evaluate("submits")).toBe(1);
    } finally { unsubscribe(); await f.close(); }
  });

  it("refuses an already filled input", async () => {
    // Given
    let recognitions = 0;
    const f = await setup(recognizer(async () => { recognitions++; return { text: "K7M2X9", confidence: 1 }; }));
    await f.page.evaluate("document.querySelector('#answer').value='USER'");
    try {
      // When
      await f.engine.createJob(f.plan); await f.engine.validateJob(f.plan.jobId); await f.engine.armJob(f.plan.jobId);
      const result = await f.outcome.result;
      // Then
      expect(result.captcha).toMatchObject({ state: "FAILED", error: "GUARD_REJECTED", inputs: 0, submissions: 0 });
      expect(await f.page.inputValue("#answer")).toBe("USER");
      expect(recognitions).toBe(0);
      expect(f.fixture.attempts).toEqual([]);
    } finally { await f.close(); }
  });

  it("rejects a high-confidence result outside the configured length", async () => {
    // Given
    const f = await setup(recognizer(async () => ({ text: "K7M2X", confidence: 1 })));
    try {
      // When
      await f.engine.createJob(f.plan); await f.engine.validateJob(f.plan.jobId); await f.engine.armJob(f.plan.jobId);
      const result = await f.outcome.result;
      // Then
      expect(result.captcha).toMatchObject({ state: "FAILED", error: "INVALID_TEXT", inputs: 0, submissions: 0 });
      expect(await f.page.inputValue("#answer")).toBe("");
      expect(f.fixture.attempts).toEqual([]);
    } finally { await f.close(); }
  });

  it("does not click the original action again through an aliased submit selector", async () => {
    // Given
    const f = await setup(recognizer(async () => ({ text: "K7M2X9", confidence: 1 })));
    const plan = parsePlan({ ...f.plan, captcha: { ...f.plan.captcha, submitSelector: "button#reserve" } });
    try {
      // When
      await f.engine.createJob(plan); await f.engine.validateJob(plan.jobId); await f.engine.armJob(plan.jobId);
      const result = await f.outcome.result;
      // Then
      expect(result.captcha).toMatchObject({ state: "FAILED", error: "GUARD_REJECTED", inputs: 0, submissions: 0 });
      expect(await f.page.evaluate("clicks")).toBe(1);
      expect(f.fixture.attempts).toEqual([]);
    } finally { await f.close(); }
  });

  it.each([
    { target: "#reserve", submit: "#reserve-label" },
    { target: "#reserve-label", submit: "#reserve-icon" },
    { target: "#reserve-label", submit: "#reserve-icon", submitRole: "button" },
    { target: "#reserve-label", submit: "#reserve-icon", submitRole: "link" },
    { target: "#reserve-label", submit: "#reserve-icon", targetRole: "button", submitRole: "button" },
  ])("rejects submit controls that bubble to the original action: %j", async ({ target, submit, targetRole, submitRole }) => {
    // Given
    const f = await setup(recognizer(async () => ({ text: "K7M2X9", confidence: 1 })));
    if (targetRole) await f.page.locator(target).evaluate((node, role) => node.setAttribute("role", role), targetRole);
    if (submitRole) await f.page.locator(submit).evaluate((node, role) => node.setAttribute("role", role), submitRole);
    const plan = parsePlan({ ...f.plan, target: { ...f.plan.target, selector: target },
      trigger: { type: "ELEMENT_ENABLE", selector: target }, captcha: { ...f.plan.captcha, submitSelector: submit } });
    let progressed = () => {};
    const progress = new Promise<void>(resolve => { progressed = resolve; });
    const unsubscribe = f.engine.subscribe(status => {
      if (status.captcha?.state === "FAILED" || (status.captcha?.inputs ?? 0) > 0) progressed();
    });
    try {
      // When
      await f.engine.createJob(plan); await f.engine.validateJob(plan.jobId); await f.engine.armJob(plan.jobId);
      await progress;
      expect(await f.page.evaluate("clicks")).toBe(1);
      const result = await f.outcome.result;
      // Then
      expect(result.captcha).toMatchObject({ state: "FAILED", error: "GUARD_REJECTED", inputs: 0, submissions: 0 });
      expect(await f.page.evaluate("clicks")).toBe(1);
      expect(f.fixture.attempts).toEqual([]);
    } finally { unsubscribe(); await f.close(); }
  });

  it("rechecks original-control containment after input handlers move the submit node", async () => {
    // Given
    const f = await setup(recognizer(async () => ({ text: "K7M2X9", confidence: 1 })));
    await f.page.evaluate(`document.querySelector('#answer').addEventListener('input',()=>{
      document.querySelector('#reserve').append(document.querySelector('#submit'));
    },{once:true})`);
    try {
      // When
      await f.engine.createJob(f.plan); await f.engine.validateJob(f.plan.jobId); await f.engine.armJob(f.plan.jobId);
      const result = await f.outcome.result;
      // Then
      expect(result.captcha).toMatchObject({ state: "UNKNOWN", inputs: 1, submissions: 0 });
      expect(await f.page.evaluate("clicks")).toBe(1);
      expect(f.fixture.attempts).toEqual([]);
    } finally { await f.close(); }
  });

  it.runIf(process.platform === "darwin")("recognizes the actual cropped image using native Vision", async () => {
    // Given
    const f = await setup(new VisionRecognizer());
    try {
      // When
      await f.engine.createJob(f.plan); await f.engine.validateJob(f.plan.jobId); await f.engine.armJob(f.plan.jobId);
      const result = await f.outcome.result;
      // Then
      expect(result.captcha).toMatchObject({ state: "VERIFIED", inputs: 1, submissions: 1 });
      expect(f.fixture.attempts).toEqual([f.fixture.answer]);
    } finally { await f.close(); }
  }, 45000);
});
