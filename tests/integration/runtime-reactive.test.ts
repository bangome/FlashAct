import { expect } from "vitest";
import { z } from "zod";
import type { Trigger } from "../../src/core/types.js";
import { arm, clicks, install, plan, status, test, waitState } from "./runtime-fixture.js";

test.for(["ELEMENT_APPEAR", "ELEMENT_ENABLE", "ELEMENT_VISIBLE"] as const)("fires initial %s state at arm", async (type, { page }) => {
  // Given
  await install(page, plan({ trigger: { type, selector: "#action" } }));
  // When
  const result = await arm(page);
  // Then
  expect(result.state).toBe("VERIFIED");
  expect(await clicks(page)).toBe(1);
});

test("resolves an initially missing APPEAR action exactly once within approved root", async ({ page }) => {
  // Given
  await page.locator("#action").evaluate((element) => { element.remove(); });
  await install(page, plan({ target: { tabId: "owned-test-tab", url: "https://runtime.test/", selector: "#action", watchRoot: "body" } }));
  await arm(page);
  // When
  await page.evaluate(() => {
    const button = document.createElement("button"); button.id = "action"; button.textContent = "Run";
    document.body.append(button);
  });
  const result = await waitState(page, "VERIFIED");
  // Then
  expect(result.executions).toBe(1);
  expect(result.timing?.observerEpochMs).toBeGreaterThan(0);
  expect(await clicks(page)).toBe(1);
});

test("fires ENABLE when a disabled target becomes enabled", async ({ page }) => {
  // Given
  await page.locator("#action").evaluate((element) => element.setAttribute("disabled", ""));
  await install(page, plan({ trigger: { type: "ELEMENT_ENABLE", selector: "#action" } }));
  await arm(page);
  // When
  await page.locator("#action").evaluate((element) => element.removeAttribute("disabled"));
  await waitState(page, "VERIFIED");
  // Then
  expect(await clicks(page)).toBe(1);
});

test("observes CSS visibility changes without DOM mutations", async ({ page }) => {
  // Given
  await page.addStyleTag({ content: "#action { visibility: hidden; }" });
  await install(page, plan({ trigger: { type: "ELEMENT_VISIBLE", selector: "#action" } }));
  await arm(page);
  // When
  await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSStyleRule && rule.selectorText === "#action") rule.style.visibility = "visible";
      }
    }
  });
  await waitState(page, "VERIFIED");
  // Then
  expect(await clicks(page)).toBe(1);
});

const changes: readonly Trigger[] = [
  { type: "TEXT_CHANGE", selector: "#signal" },
  { type: "TEXT_CHANGE", selector: "#signal", value: "ready" },
  { type: "ATTRIBUTE_CHANGE", selector: "#signal", attribute: "data-state" },
  { type: "ATTRIBUTE_CHANGE", selector: "#signal", attribute: "data-state", value: "ready" },
];
test.for(changes)("compares baseline or expected value for $type $value", async (trigger, { page }) => {
  // Given
  await page.locator("#signal").evaluate((element) => element.setAttribute("data-state", "idle"));
  await install(page, plan({ trigger }));
  await arm(page);
  expect(await clicks(page)).toBe(0);
  // When
  await page.locator("#signal").evaluate((element) => { element.textContent = "ready"; element.setAttribute("data-state", "ready"); });
  await waitState(page, "VERIFIED");
  // Then
  expect(await clicks(page)).toBe(1);
});

test("uses ARM baseline rather than INSTALL baseline for unspecified changes", async ({ page }) => {
  // Given
  await install(page, plan({ trigger: { type: "TEXT_CHANGE", selector: "#signal" } }));
  await page.locator("#signal").evaluate((element) => { element.textContent = "new baseline"; });
  // When
  await arm(page);
  // Then
  expect((await status(page)).state).toBe("WAITING");
  expect(await clicks(page)).toBe(0);
});

test("dispatches once under concurrent mutation and reentrant arm calls", async ({ page }) => {
  // Given
  await install(page, plan({ trigger: { type: "OR", conditions: changes } }));
  await page.locator("#action").evaluate((element) => {
    element.addEventListener("click", () => {
      const result = globalThis.__flashactRuntime?.arm("runtime-test");
      document.body.dataset["duringClick"] = result?.state;
      document.body.dataset["duringExecutions"] = String(result?.executions);
    });
  });
  await arm(page);
  // When
  await page.locator("#signal").evaluate((element) => {
    for (let index = 0; index < 100; index++) { element.textContent = String(index); element.setAttribute("data-state", String(index)); }
  });
  await waitState(page, "VERIFIED");
  // Then
  expect(await clicks(page)).toBe(1);
  expect(await page.evaluate(() => [document.body.dataset["duringClick"], document.body.dataset["duringExecutions"]])).toEqual(["DISPATCHED", "1"]);
});

test("does not match the wrong specified value", async ({ page }) => {
  // Given
  await install(page, plan({ expiresAt: Date.now() + 160, trigger: { type: "TEXT_CHANGE", selector: "#signal", value: "approved" } }));
  await arm(page);
  // When
  await page.locator("#signal").evaluate((element) => { element.textContent = "wrong"; });
  await waitState(page, "EXPIRED");
  // Then
  expect(await clicks(page)).toBe(0);
});

test("waits for a CAPTCHA using events and expiry rather than a readiness interval", async ({ page }) => {
  // Given: freeze the browser epoch so the only deadline has an exact duration.
  const epoch = 1_800_000_000_000;
  await page.evaluate(`Date.now=()=>${epoch};
    document.querySelector('#action').hidden=true;
    window.captchaWaitTimers=[];
    const nativeTimeout=window.setTimeout;
    window.setTimeout=(handler,delay,...args)=>{
      captchaWaitTimers.push(delay);return nativeTimeout(handler,delay,...args);
    };`);
  await install(page, plan({ action: { type: "captcha" }, expiresAt: epoch + 60000,
    captcha: { imageSelector: "#action", inputSelector: "#answer", alphabet: "digits",
      length: 6, minConfidence: 0.8, timeoutMs: 15000 } }));
  expect((await arm(page)).state).toBe("WAITING");
  const delays: unknown = await page.evaluate("captchaWaitTimers");
  expect(new Set(z.array(z.number()).parse(delays))).toEqual(new Set([60000]));
  // When: subscribe before revealing the target, without forcing a wake.
  await page.evaluate(() => new Promise<void>(resolve => {
    const changed = () => {
      if (globalThis.__flashactRuntime?.status("runtime-test").state === "VERIFIED") {
        document.removeEventListener("__flashact_status__", changed); resolve();
      }
    };
    document.addEventListener("__flashact_status__", changed);
    const element = document.querySelector("#action");
    if (!(element instanceof HTMLElement)) throw new Error("Missing fixture target");
    element.hidden = false;
  }));
  // Then
  const result = await status(page);
  expect(result).toMatchObject({ state: "VERIFIED", executions: 1 });
  expect(result.timing?.clickEpochMs).toBeUndefined();
  expect(await clicks(page)).toBe(0);
});
