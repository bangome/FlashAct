import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AsideSession } from "../../src/adapters/aside/session.js";
import { decodeAsideOutput } from "../../src/adapters/aside/runner.js";
import { JobEngine } from "../../src/core/engine.js";
import { parsePlan } from "../../src/core/schema.js";
import { captchaFixture, captchaOutcome, captchaPlan } from "../fixtures/captcha.js";

describe.runIf(process.env["FLASHACT_ASIDE_INTEGRATION"] === "1")("owned Aside captcha", () => {
  it.each(["click", "captcha"].flatMap(action =>
    [false, true].map(ordinaryBeforeCaptcha => ({ action, ordinaryBeforeCaptcha }))))(
    "recognizes a confirmed screen after $action with ordinaryBeforeCaptcha=$ordinaryBeforeCaptcha",
    async ({ action, ordinaryBeforeCaptcha }) => {
    // Given
    const externalAppearance = ordinaryBeforeCaptcha || action === "captcha";
    const fixture = await captchaFixture({ externalAppearance, ordinaryBeforeCaptcha });
    const owner = new AsideSession();
    const engine = new JobEngine({ adapterMode: "owned" });
    const marker = `__CAPTCHA_${randomUUID()}__`;
    let tabId: string | undefined;
    const outcome = captchaOutcome(engine);
    try {
      const output = await owner.run("aside", ["repl", `await openTab(${JSON.stringify(fixture.url)});
        const ownCaptchaTab = (await listBrowserTabs()).find(tab=>tab.url===${JSON.stringify(fixture.url)});
        console.log(${JSON.stringify(marker)}+JSON.stringify({kind:"value",value:ownCaptchaTab?.targetId}));`]);
      const id = decodeAsideOutput(output, marker);
      if (typeof id !== "string") throw new Error("Owned tab not found");
      tabId = id;
      const original = captchaPlan(tabId, fixture.url);
      const plan = parsePlan({ ...original, backend: "aside", action: { type: action },
        ...(action === "captcha" ? { target: { ...original.target, selector: "#image" },
          trigger: { type: "ELEMENT_APPEAR", selector: "#image" } } : {}) });
      // When
      await engine.createJob(plan); await engine.validateJob(plan.jobId); await engine.armJob(plan.jobId);
      if (externalAppearance) {
        expect((await engine.getStatus(plan.jobId)).captcha?.state).toBe("WAITING");
        expect(engine.logs().some(status =>
          status.captcha?.state === "CAPTURING" || status.captcha?.state === "RECOGNIZING")).toBe(false);
        expect(fixture.attempts).toEqual([]);
        await fixture.reveal();
      }
      const result = await outcome.result;
      // Then
      console.log(JSON.stringify({ captchaAcceptance: "aside", action, ordinaryBeforeCaptcha, state: result.captcha,
        effects: fixture.attempts.length, receipts: fixture.receipts }));
      expect(result).toMatchObject({ executions: 1, captcha: { state: "VERIFIED", inputs: 1, submissions: 1 } });
      expect(fixture.attempts).toEqual([fixture.answer]);
      expect(fixture.receipts).toEqual([expect.objectContaining({
        clicks: action === "click" ? 1 : 0, imageClicks: 0, inputs: 1,
      })]);
      if (action === "captcha") expect(result.timing?.clickEpochMs).toBeUndefined();
    } finally {
      outcome.dispose();
      try { await engine.close(); }
      finally {
        try {
          if (tabId) await owner.run("aside", ["repl", `await closeTab(getTabByTargetId(${JSON.stringify(tabId)}));`]);
        } finally { await owner.stop(); await fixture.close(); }
      }
    }
  }, 60000);
});
