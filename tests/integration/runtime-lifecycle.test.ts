import { expect } from "vitest";
import { cancelExpression, runtimeSource } from "../../src/runtime/index.js";
import { arm, clicks, install, plan, status, test, waitState } from "./runtime-fixture.js";
import { RuntimeJobs } from "../../src/adapters/playwright/runtime-jobs.js";
import type { JobStatus } from "../../src/core/types.js";

test("returns the same handle for duplicate plans and rejects conflicting IDs", async ({ page }) => {
  // Given
  const input = plan();
  const first = await install(page, input);
  await arm(page);
  // When
  const duplicate = await install(page, { ...input, target: { url: input.target.url, selector: input.target.selector, tabId: input.target.tabId } });
  await arm(page);
  // Then
  expect(duplicate).toEqual(first);
  expect(await clicks(page)).toBe(1);
  await expect(install(page, { ...input, name: "conflicting" })).rejects.toThrow();
});

test("cancels waiting jobs without dispatch on later mutations", async ({ page }) => {
  // Given
  await install(page, plan({ trigger: { type: "TEXT_CHANGE", selector: "#signal" } }));
  await arm(page);
  // When
  await page.evaluate(cancelExpression("runtime-test"));
  await page.locator("#signal").evaluate((element) => { element.textContent = "ready"; });
  await arm(page);
  // Then
  expect((await status(page)).state).toBe("CANCELLED");
  expect(await clicks(page)).toBe(0);
});

test("expires jobs whose reactive condition never occurs", async ({ page }) => {
  // Given
  await install(page, plan({ expiresAt: Date.now() + 120, trigger: { type: "ELEMENT_APPEAR", selector: "#missing" } }));
  // When
  await arm(page);
  const result = await waitState(page, "EXPIRED");
  // Then
  expect(result.executions).toBe(0);
  expect(await clicks(page)).toBe(0);
});

test.for(["pagehide", "beforeunload"] as const)("invalidates on %s without reinstalling", async (event, { page }) => {
  // Given
  await install(page, plan({ trigger: { type: "TEXT_CHANGE", selector: "#signal" } }));
  await arm(page);
  // When
  await page.evaluate((name) => { window.dispatchEvent(new Event(name)); }, event);
  await page.evaluate(runtimeSource());
  await page.locator("#signal").evaluate((element) => { element.textContent = "ready"; });
  await arm(page);
  // Then
  expect((await status(page)).state).toBe("INVALIDATED");
  expect(await clicks(page)).toBe(0);
});

test("invalidates on history URL change before dispatch", async ({ page }) => {
  // Given
  await install(page, plan({ trigger: { type: "TEXT_CHANGE", selector: "#signal" } }));
  await arm(page);
  // When
  await page.evaluate(() => { history.pushState({}, "", "/changed"); });
  await waitState(page, "INVALIDATED");
  // Then
  expect(await clicks(page)).toBe(0);
});

test("does not carry runtime jobs across document navigation", async ({ page }) => {
  // Given
  await install(page, plan({ trigger: { type: "TEXT_CHANGE", selector: "#signal" } }));
  await arm(page);
  // When
  await page.goto("https://runtime.test/next");
  // Then
  expect(await page.evaluate(() => globalThis.__flashactRuntime === undefined)).toBe(true);
  await expect(status(page)).rejects.toThrow();
});

test("verifies a selector inserted asynchronously after click", async ({ page }) => {
  // Given
  await page.locator("#action").evaluate((element) => {
    element.addEventListener("click", () => queueMicrotask(() => {
      const marker = document.createElement("div"); marker.id = "verified"; document.body.append(marker);
    }));
  });
  await install(page, plan({ verification: { selector: "#verified", timeoutMs: 300 } }));
  // When
  await arm(page);
  const result = await waitState(page, "VERIFIED");
  // Then
  expect(result.executions).toBe(1);
  expect(await clicks(page)).toBe(1);
});

test("returns UNKNOWN after verification timeout without repeating the click", async ({ page }) => {
  // Given
  await install(page, plan({ verification: { selector: "#never", timeoutMs: 80 } }));
  // When
  await arm(page);
  const result = await waitState(page, "UNKNOWN");
  await arm(page);
  // Then
  expect(result.executions).toBe(1);
  expect(await clicks(page)).toBe(1);
});

test("records UNKNOWN for a thrown page listener without retrying", async ({ page }) => {
  // Given
  await page.locator("#action").evaluate((element) => { element.addEventListener("click", () => { throw new TypeError("listener failed"); }); });
  await install(page, plan());
  // When
  const result = await arm(page);
  await arm(page);
  // Then
  expect(result.state).toBe("UNKNOWN");
  expect(result.executions).toBe(1);
  expect(await clicks(page)).toBe(1);
});

test("invalidates rather than verifies when a click changes the URL", async ({ page }) => {
  // Given
  await page.locator("#action").evaluate((element) => { element.addEventListener("click", () => history.pushState({}, "", "/after-click")); });
  await install(page, plan());
  // When
  const result = await arm(page);
  // Then
  expect(result.state).toBe("INVALIDATED");
  expect(result.executions).toBe(1);
  expect(await clicks(page)).toBe(1);
});

test.for(["VERIFIED", "UNKNOWN"] as const)("pushes delayed %s through the installed reporter without status polling", async (state, { page }) => {
  // Given
  let evaluations = 0;
  let observed: (status: JobStatus) => void = () => undefined;
  const completed = new Promise<JobStatus>(resolve => { observed = resolve; });
  const jobs = new RuntimeJobs(async (_tabId, expression) => {
    evaluations++;
    return page.evaluate(expression);
  }, true, result => { if (result.state === state) observed(result); });
  const receive = (message: { text(): string }) => jobs.receive(message.text());
  page.on("console", receive);
  const input = plan({ verification: { selector: "#receipt", timeoutMs: state === "UNKNOWN" ? 80 : 3000 } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await jobs.install(input);
    await jobs.arm(input);
    const before = evaluations;
    // When: verification occurs only after the arm task has completed.
    if (state === "VERIFIED") await page.evaluate(() => {
      const receipt = document.createElement("span"); receipt.id = "receipt"; document.body.append(receipt);
    });
    const result = await Promise.race([completed, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Runtime lifecycle event missing")), 3000);
    })]);
    // Then
    expect(result).toMatchObject({ state, executions: 1, timing: { clickEpochMs: expect.any(Number) } });
    expect(evaluations).toBe(before);
    expect(jobs.snapshot()).toEqual([result]);
    expect(await clicks(page)).toBe(1);
  } finally {
    if (timer) clearTimeout(timer);
    page.off("console", receive);
  }
});
