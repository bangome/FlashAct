import { expect } from "vitest";
import type { Page } from "playwright";
import { arm, clicks, install, plan, status, test } from "./runtime-fixture.js";

declare global { var __timingClick: Promise<void>; }

async function prepareClock(page: Page): Promise<number> {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1_600_000_000_000);
  // pauseAt advances wall time, not the same monotonic epoch. Align on the
  // already navigated test document and keep preparation frozen.
  const epoch = await page.evaluate(() => Math.floor(performance.timeOrigin + performance.now()));
  await page.clock.setSystemTime(epoch);
  await page.evaluate(() => {
    const target = document.querySelector("#action");
    if (!target) throw new TypeError("Missing test action");
    globalThis.__timingClick = new Promise<void>(resolve => {
      target.addEventListener("click", () => queueMicrotask(() => resolve()), { once: true });
    });
  });
  return epoch;
}

async function clickedStatus(page: Page) {
  await page.evaluate(() => globalThis.__timingClick);
  return status(page);
}

test("does not arm during install and dispatches once after the scheduled epoch", async ({ page }) => {
  // Given
  const at = await prepareClock(page) + 180;
  await install(page, plan({ trigger: { type: "SCHEDULED", at } }));
  expect((await status(page)).state).toBe("VALIDATED");
  expect(await clicks(page)).toBe(0);
  // When
  await arm(page);
  await page.clock.runFor(179);
  expect(await clicks(page)).toBe(0);
  await page.clock.runFor(1);
  const result = await clickedStatus(page);
  // Then
  expect(result.executions).toBe(1);
  expect(result.timing?.clickEpochMs).toBeGreaterThanOrEqual(at);
  expect(await page.evaluate(() => Number(document.body.dataset["clickTime"]))).toBeGreaterThanOrEqual(at);
  expect(result.timing?.receivedEpochMs).toBeLessThanOrEqual(result.timing?.clickEpochMs ?? 0);
  expect(result.timing?.schedulerEpochMs).toBeGreaterThan(0);
  expect(await clicks(page)).toBe(1);
  expect(await page.evaluate(() => document.body.dataset["trusted"])).toBe("false");
});

test.for(["condition-first", "time-first"] as const)("evaluates scheduled AND in %s order", async (order, { page }) => {
  // Given
  const at = await prepareClock(page) + 180;
  await install(page, plan({ trigger: { type: "AND", conditions: [
    { type: "SCHEDULED", at }, { type: "TEXT_CHANGE", selector: "#signal", value: "ready" },
  ] } }));
  await arm(page);
  // When
  if (order === "time-first") {
    await page.clock.runFor(180);
    expect(await clicks(page)).toBe(0);
  }
  await page.locator("#signal").evaluate((element) => { element.textContent = "ready"; });
  if (order === "condition-first") await page.clock.runFor(180);
  const result = await clickedStatus(page);
  // Then
  expect(result.timing?.clickEpochMs).toBeGreaterThanOrEqual(at);
  expect(await clicks(page)).toBe(1);
});

test("allows reactive OR to win before a future scheduled leaf", async ({ page }) => {
  // Given
  const at = await prepareClock(page) + 60_000;
  await install(page, plan({ trigger: { type: "OR", conditions: [
    { type: "SCHEDULED", at }, { type: "TEXT_CHANGE", selector: "#signal", value: "ready" },
  ] } }));
  await arm(page);
  // When
  await page.locator("#signal").evaluate((element) => { element.textContent = "ready"; });
  const result = await clickedStatus(page);
  // Then
  expect(result.timing?.clickEpochMs).toBeLessThan(at);
  expect(await clicks(page)).toBe(1);
});

test("does not latch enabled state after it reverses before scheduled AND", async ({ page }) => {
  // Given
  const at = await prepareClock(page) + 180;
  await install(page, plan({ trigger: { type: "AND", conditions: [
    { type: "ELEMENT_ENABLE", selector: "#action" }, { type: "SCHEDULED", at },
  ] } }));
  await arm(page);
  // When
  await page.locator("#action").evaluate((element) => { element.setAttribute("disabled", ""); });
  await page.clock.runFor(230);
  // Then
  expect((await status(page)).state).toBe("WAITING");
  expect(await clicks(page)).toBe(0);
});

test("does not latch visible state after it reverses before scheduled AND", async ({ page }) => {
  // Given
  const at = await prepareClock(page) + 180;
  await install(page, plan({ trigger: { type: "AND", conditions: [
    { type: "ELEMENT_VISIBLE", selector: "#signal" }, { type: "SCHEDULED", at },
  ] } }));
  await arm(page);
  // When
  await page.locator("#signal").evaluate((element) => { element.setAttribute("hidden", ""); });
  await page.clock.runFor(230);
  // Then
  expect((await status(page)).state).toBe("WAITING");
  expect(await clicks(page)).toBe(0);
});

test("caps distant scheduled timers and expires without overflow dispatch", async ({ page }) => {
  // Given
  const epoch = await prepareClock(page);
  await install(page, plan({ expiresAt: epoch + 150, trigger: { type: "SCHEDULED", at: epoch + 2 ** 32 } }));
  // When
  await arm(page);
  await page.clock.runFor(150);
  const result = await status(page);
  // Then
  expect(result.executions).toBe(0);
  expect(await clicks(page)).toBe(0);
});
