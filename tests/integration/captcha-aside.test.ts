import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AsideSession } from "../../src/adapters/aside/session.js";
import { decodeAsideOutput } from "../../src/adapters/aside/runner.js";
import { JobEngine } from "../../src/core/engine.js";
import { parsePlan } from "../../src/core/schema.js";
import { captchaFixture, captchaOutcome, captchaPlan } from "../fixtures/captcha.js";

describe.runIf(process.env["FLASHACT_ASIDE_INTEGRATION"] === "1")("owned Aside captcha", () => {
  it("recognizes and submits only an authored local challenge and joins its owners", async () => {
    // Given
    const fixture = await captchaFixture();
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
      const plan = parsePlan({ ...captchaPlan(tabId, fixture.url), backend: "aside" });
      // When
      await engine.createJob(plan); await engine.validateJob(plan.jobId); await engine.armJob(plan.jobId);
      const result = await outcome.result;
      // Then
      console.log(JSON.stringify({ captchaAcceptance: "aside", state: result.captcha, effects: fixture.attempts.length }));
      expect(result).toMatchObject({ executions: 1, captcha: { state: "VERIFIED", inputs: 1, submissions: 1 } });
      expect(fixture.attempts).toEqual([fixture.answer]);
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
