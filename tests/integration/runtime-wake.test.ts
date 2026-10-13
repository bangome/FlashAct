import type { Page } from "playwright";
import { expect } from "vitest";
import type { ExecutionPlan } from "../../src/core/types.js";
import { wakeExpression } from "../../src/runtime/index.js";
import { arm, clicks, install, plan, test } from "./runtime-fixture.js";

const epoch = 2_000_000_000_000;

declare global {
  var __wakeClock: {
    wall: number;
    monotonic: number;
    readonly timers: Map<number, () => void>;
    delivered: number;
  };
}

async function prepare(page: Page, overrides: Partial<ExecutionPlan> = {}) {
  // Test-only clocks separate readiness from callback delivery. No production hooks.
  await page.evaluate((now) => {
    const clock = { wall: now, monotonic: now, timers: new Map<number, () => void>(), delivered: 0 };
    globalThis.__wakeClock = clock;
    Date.now = () => clock.wall;
    Object.defineProperty(performance, "now", { value: () => clock.monotonic - performance.timeOrigin });
    let nextTimer = 0;
    Object.defineProperty(window, "setTimeout", { value: (handler: TimerHandler, _delay?: number, ...args: unknown[]) => {
      if (typeof handler !== "function") throw new TypeError("Expected a timer callback");
      const id = ++nextTimer;
      clock.timers.set(id, () => { clock.delivered++; handler(...args); });
      return id;
    } });
    Object.defineProperty(window, "clearTimeout", { value: (id: number) => { clock.timers.delete(id); } });
  }, epoch);
  await install(page, plan({ trigger: { type: "SCHEDULED", at: epoch + 100 }, expiresAt: epoch + 1000, ...overrides }));
}

test("leaves an unarmed plan unchanged and rejects unknown IDs like arm", async ({ page }) => {
  // Given
  await prepare(page);
  // When
  const wire = await page.evaluate(wakeExpression("runtime-test"));
  // Then
  expect(JSON.parse(String(wire))).toMatchObject({ state: "VALIDATED", executions: 0 });
  expect(await clicks(page)).toBe(0);
  await expect(page.evaluate(wakeExpression("unknown"))).rejects.toThrow();
  await expect(arm(page, "unknown")).rejects.toThrow();
});

test.for(["wall", "monotonic"] as const)("requires the %s clock even when the other is due", async (lagging, { page }) => {
  // Given
  await prepare(page);
  // When
  const result = await page.evaluate((slow) => {
    const runtime = globalThis.__flashactRuntime;
    if (!runtime) throw new TypeError("Missing runtime");
    runtime.arm("runtime-test");
    const clock = globalThis.__wakeClock;
    clock.wall += 100;
    clock.monotonic += 100;
    clock[slow] -= 1;
    const early = runtime.wake("runtime-test");
    const observerEpoch = early.timing?.observerEpochMs;
    clock[slow] += 1;
    const due = runtime.wake("runtime-test");
    return { early, due, observerEpoch, delivered: clock.delivered };
  }, lagging);
  // Then
  expect(result.early).toMatchObject({ state: "WAITING", executions: 0 });
  expect(result.due).toMatchObject({ state: "VERIFIED", executions: 1 });
  expect(result.due.timing?.observerEpochMs).toBe(result.observerEpoch);
  expect(result.due.timing?.schedulerEpochMs).toBeUndefined();
  expect(result.delivered).toBe(0);
  expect(await clicks(page)).toBe(1);
});

test.for(["wake-first", "timer-first"] as const)("claims execution before reentrant callbacks with %s", async (order, { page }) => {
  // Given
  await prepare(page);
  await arm(page);
  // When
  const result = await page.evaluate(async (first) => {
    const runtime = globalThis.__flashactRuntime;
    const target = document.querySelector("#action");
    const signal = document.querySelector("#signal");
    if (!runtime || !target || !signal) throw new TypeError("Missing fixture");
    const timer = globalThis.__wakeClock.timers.values().next().value;
    if (!timer) throw new TypeError("Missing scheduled callback");
    let reentrantState = "";
    target.addEventListener("click", () => {
      reentrantState = runtime.wake("runtime-test").state;
      runtime.arm("runtime-test");
      timer();
      signal.textContent = "observer ready";
    });
    globalThis.__wakeClock.wall += 100;
    globalThis.__wakeClock.monotonic += 100;
    if (first === "timer-first") timer();
    const due = runtime.wake("runtime-test");
    timer();
    runtime.wake("runtime-test");
    await Promise.resolve(); // Exact mutation-observer microtask checkpoint, not a time wait.
    return { due, final: runtime.wake("runtime-test"), reentrantState };
  }, order);
  // Then
  expect(result.reentrantState).toBe("DISPATCHED");
  expect(result.due).toMatchObject({ state: "VERIFIED", executions: 1 });
  expect(result.final).toEqual(result.due);
  expect(await clicks(page)).toBe(1);
});

test("does not redispatch while asynchronous verification remains DISPATCHED", async ({ page }) => {
  // Given
  await prepare(page, { verification: { selector: "#never", timeoutMs: 100 } });
  await arm(page);
  // When
  const result = await page.evaluate(() => {
    const runtime = globalThis.__flashactRuntime;
    if (!runtime) throw new TypeError("Missing runtime");
    globalThis.__wakeClock.wall += 100;
    globalThis.__wakeClock.monotonic += 100;
    const first = runtime.wake("runtime-test");
    return { first, second: runtime.wake("runtime-test") };
  });
  // Then
  expect(result.first).toMatchObject({ state: "DISPATCHED", executions: 1 });
  expect(result.second).toEqual(result.first);
  expect(await clicks(page)).toBe(1);
});

test.for(["schedule-first", "reactive-first"] as const)("requires every AND leaf with %s readiness", async (order, { page }) => {
  // Given
  await prepare(page, { trigger: { type: "AND", conditions: [
    { type: "SCHEDULED", at: epoch + 100 }, { type: "SCHEDULED", at: epoch + 200 },
    { type: "TEXT_CHANGE", selector: "#signal", value: "ready" },
  ] } });
  await arm(page);
  // When
  const result = await page.evaluate((first) => {
    const runtime = globalThis.__flashactRuntime;
    const signal = document.querySelector("#signal");
    if (!runtime || !signal) throw new TypeError("Missing fixture");
    globalThis.__wakeClock.wall += 100;
    globalThis.__wakeClock.monotonic += 100;
    if (first === "reactive-first") signal.textContent = "ready";
    const oneLeaf = runtime.wake("runtime-test");
    globalThis.__wakeClock.wall += 100;
    globalThis.__wakeClock.monotonic += 100;
    const intermediate = runtime.wake("runtime-test");
    if (first === "schedule-first") signal.textContent = "ready";
    return { oneLeaf, intermediate, final: runtime.wake("runtime-test") };
  }, order);
  // Then
  expect(result.oneLeaf.state).toBe("WAITING");
  expect(result.intermediate.state).toBe(order === "schedule-first" ? "WAITING" : "VERIFIED");
  expect(result.final).toMatchObject({ state: "VERIFIED", executions: 1 });
  expect(await clicks(page)).toBe(1);
});

test("allows an OR reactive leaf before scheduled readiness", async ({ page }) => {
  // Given
  await prepare(page, { trigger: { type: "OR", conditions: [
    { type: "SCHEDULED", at: epoch + 100 },
    { type: "TEXT_CHANGE", selector: "#signal", value: "ready" },
  ] } });
  await arm(page);
  // When
  const result = await page.evaluate(() => {
    const signal = document.querySelector("#signal");
    if (!signal || !globalThis.__flashactRuntime) throw new TypeError("Missing fixture");
    signal.textContent = "ready";
    return globalThis.__flashactRuntime.wake("runtime-test");
  });
  // Then
  expect(result).toMatchObject({ state: "VERIFIED", executions: 1 });
  expect(await clicks(page)).toBe(1);
});

test("does not latch a reactive AND leaf that becomes false before due wake", async ({ page }) => {
  // Given
  await prepare(page, { trigger: { type: "AND", conditions: [
    { type: "SCHEDULED", at: epoch + 100 }, { type: "TEXT_CHANGE", selector: "#signal", value: "ready" },
  ] } });
  await arm(page);
  // When
  const result = await page.evaluate(() => {
    const runtime = globalThis.__flashactRuntime;
    const signal = document.querySelector("#signal");
    if (!runtime || !signal) throw new TypeError("Missing fixture");
    signal.textContent = "ready";
    runtime.wake("runtime-test");
    signal.textContent = "idle";
    globalThis.__wakeClock.wall += 100;
    globalThis.__wakeClock.monotonic += 100;
    const falseAgain = runtime.wake("runtime-test");
    signal.textContent = "ready";
    return { falseAgain, final: runtime.wake("runtime-test") };
  });
  // Then
  expect(result.falseAgain.state).toBe("WAITING");
  expect(result.final).toMatchObject({ state: "VERIFIED", executions: 1 });
  expect(await clicks(page)).toBe(1);
});

test("does not repeat observer dispatch when wake follows the exact click event", async ({ page }) => {
  // Given
  await prepare(page, { trigger: { type: "TEXT_CHANGE", selector: "#signal", value: "ready" } });
  await arm(page);
  // When
  const result = await page.evaluate(async () => {
    const runtime = globalThis.__flashactRuntime;
    const target = document.querySelector("#action");
    const signal = document.querySelector("#signal");
    if (!runtime || !target || !signal) throw new TypeError("Missing fixture");
    const clicked = new Promise<void>((resolve) => target.addEventListener("click", () => resolve(), { once: true }));
    signal.textContent = "ready";
    await clicked;
    return runtime.wake("runtime-test");
  });
  // Then
  expect(result).toMatchObject({ state: "VERIFIED", executions: 1 });
  expect(await clicks(page)).toBe(1);
});

test.for(["cancel-first", "wake-first"] as const)("honors cancellation ordering with %s", async (order, { page }) => {
  // Given
  await prepare(page);
  await arm(page);
  // When
  const result = await page.evaluate((first) => {
    const runtime = globalThis.__flashactRuntime;
    if (!runtime) throw new TypeError("Missing runtime");
    globalThis.__wakeClock.wall += 100;
    globalThis.__wakeClock.monotonic += 100;
    if (first === "cancel-first") runtime.cancel("runtime-test");
    const woke = runtime.wake("runtime-test");
    runtime.cancel("runtime-test");
    return { woke, final: runtime.wake("runtime-test") };
  }, order);
  // Then
  expect(result.final).toEqual(result.woke);
  expect(result.final.state).toBe(order === "cancel-first" ? "CANCELLED" : "VERIFIED");
  expect(await clicks(page)).toBe(order === "cancel-first" ? 0 : 1);
});

test.for(["expired", "url", "remove", "replace", "detach-reattach", "ancestor-detach", "selector", "ambiguous", "disabled", "hidden", "irreversible"] as const)(
  "rejects %s synchronously before wake dispatch", async (guard, { page }) => {
    // Given
    await prepare(page, { trigger: { type: "AND", conditions: [
      { type: "SCHEDULED", at: epoch + 100 }, { type: "ELEMENT_APPEAR", selector: "#signal" },
    ] } });
    if (guard === "irreversible" || guard === "ancestor-detach") {
      await page.evaluate((change) => {
        const target = document.querySelector("#action");
        if (!target) throw new TypeError("Missing fixture target");
        const parent = document.createElement(change === "irreversible" ? "form" : "div");
        parent.id = "container";
        target.replaceWith(parent);
        parent.append(target);
      }, guard);
    }
    await arm(page);
    // When
    const result = await page.evaluate((change) => {
      const runtime = globalThis.__flashactRuntime;
      const target = document.querySelector("#action");
      if (!runtime || !target) throw new TypeError("Missing fixture");
      globalThis.__wakeClock.wall += 100;
      globalThis.__wakeClock.monotonic += 100;
      switch (change) {
        case "expired": globalThis.__wakeClock.wall += 900; break;
        case "url": history.pushState({}, "", "/changed"); break;
        case "remove": target.remove(); break;
        case "replace": target.replaceWith(target.cloneNode(true)); break;
        case "detach-reattach": target.remove(); document.body.append(target); break;
        case "ancestor-detach": {
          const parent = target.parentElement;
          if (!parent) throw new TypeError("Missing target parent");
          parent.remove(); document.body.append(parent); break;
        }
        case "selector": target.id = "changed"; break;
        case "ambiguous": document.body.prepend(target.cloneNode(true)); break;
        case "disabled": target.setAttribute("disabled", ""); break;
        case "hidden": target.setAttribute("hidden", ""); break;
        case "irreversible": target.removeAttribute("type"); break;
      }
      const first = runtime.wake("runtime-test");
      return { first, repeated: runtime.wake("runtime-test") };
    }, guard);
    // Then
    expect(result.first.state).toBe(guard === "expired" ? "EXPIRED" : guard === "url" ? "INVALIDATED" : "FAILED");
    expect(result.first.executions).toBe(0);
    expect(result.repeated).toEqual(result.first);
    expect(await clicks(page)).toBe(0);
  },
);
