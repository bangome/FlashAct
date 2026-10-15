import { createContext, runInContext } from "node:vm";
import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RuntimeJobs } from "../../src/adapters/playwright/runtime-jobs.js";
import type { ExecutionPlan, JobStatus } from "../../src/core/types.js";
import { asideChangeRead } from "../../src/adapters/aside/session.js";

const plan: ExecutionPlan = {
  schemaVersion: "1.0", jobId: "read", name: "Change read", backend: "aside",
  target: { tabId: "tab", selector: "#r", url: "about:blank" },
  trigger: { type: "ELEMENT_ENABLE", selector: "#r" }, action: { type: "click" }, timezone: "UTC",
  expiresAt: 4_102_444_810_000, maxExecutions: 1, verification: { timeoutMs: 1000 },
  guards: { approvedUrl: "about:blank", allowIrreversible: false },
};

async function fixture() {
  const document = new EventTarget();
  const window = new EventTarget();
  let status: JobStatus = { jobId: "read", state: "VALIDATED", executions: 0, updatedAt: 100,
    timing: { receivedEpochMs: 99, targetEpochMs: 101 } };
  const change = (next: JobStatus) => {
    status = next;
    document.dispatchEvent(new CustomEvent("__flashact_status__", { detail: { jobId: "read" } }));
  };
  const runtime = {
    documentId: "document",
    install: () => ({ jobId: "read", documentId: "document" }),
    status: () => status,
    arm: () => { status = { ...status, state: "WAITING" }; return status; },
    cancel: () => { change({ ...status, state: "CANCELLED" }); return status; },
  };
  const context = createContext({ __flashactRuntime: runtime, document, console: { log: () => undefined },
    window: { addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
      setTimeout, clearTimeout }, clearTimeout, Promise });
  const jobs = new RuntimeJobs(async (_tab, expression) => runInContext(expression, context), false);
  await jobs.install(plan);
  await jobs.arm(plan);
  let resolveStarted: () => void = () => {};
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  const evaluate = async (_tab: string, expression: string): Promise<unknown> => {
    const reading: unknown = runInContext(expression, context);
    resolveStarted();
    return reading;
  };
  return { jobs, document, context, change, evaluate, started };
}

describe("installation-bound event reads", () => {
  it("renews an Aside observation before the inner CDP evaluation deadline", async () => {
    // Given: the real transport expires pending Runtime.evaluate after 30 seconds.
    vi.useFakeTimers();
    const f = await fixture();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const evaluate = async (tab: string, expression: string): Promise<unknown> => {
      try {
        return await Promise.race([f.evaluate(tab, expression), new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("CDP command timeout: Runtime.evaluate")), 30000);
        })]);
      } finally { clearTimeout(timeout); }
    };
    try {
      // When: no page change happens before the transport deadline.
      const reading = f.jobs.waitForChange("read", evaluate, asideChangeRead.leaseMs);
      await f.started;
      await vi.advanceTimersByTimeAsync(30000);
      // Then: renewal observes WAITING, not UNKNOWN, without rearming.
      expect(await reading).toMatchObject({ state: "WAITING", executions: 0 });
      expect(getEventListeners(f.document, "__flashact_status__")).toHaveLength(1);
      expect(asideChangeRead.rpcTimeoutMs).toBeLessThan(30000);
    } finally { await f.jobs.disconnect(); vi.useRealTimers(); }
  });

  it("waits for changed evidence despite different JSON property order", async () => {
    // Given
    const f = await fixture();
    try {
      const reading = f.jobs.waitForChange("read", f.evaluate, 85000);
      await f.started;
      expect(getEventListeners(f.document, "__flashact_status__")).toHaveLength(2);
      // When
      f.change({ jobId: "read", state: "VERIFIED", executions: 1, updatedAt: 102 });
      // Then
      expect(await reading).toMatchObject({ state: "VERIFIED", executions: 1 });
      expect(getEventListeners(f.document, "__flashact_status__")).toHaveLength(1);
    } finally { await f.jobs.disconnect(); }
  });

  it("returns the same observed state when its explicit read lease expires", async () => {
    // Given
    vi.useFakeTimers();
    const f = await fixture();
    try {
      const reading = f.jobs.waitForChange("read", f.evaluate, 85000);
      await f.started;
      expect(getEventListeners(f.document, "__flashact_status__")).toHaveLength(2);
      // When
      await vi.advanceTimersByTimeAsync(85000);
      // Then
      expect(await reading).toMatchObject({ state: "WAITING", executions: 0 });
      expect(getEventListeners(f.document, "__flashact_status__")).toHaveLength(1);
    } finally { await f.jobs.disconnect(); vi.useRealTimers(); }
  });

  it("keeps replaced armed document bindings UNKNOWN and cannot rearm them", async () => {
    // Given
    const f = await fixture();
    try {
      const reading = f.jobs.waitForChange("read", f.evaluate, 85000);
      await f.started;
      // When
      runInContext("globalThis.__flashactRuntime = { documentId: 'replacement' }", f.context);
      f.change({ jobId: "read", state: "VERIFIED", executions: 1, updatedAt: 102 });
      // Then
      expect(await reading).toMatchObject({ state: "UNKNOWN", executions: 0 });
      await expect(f.jobs.arm(plan)).rejects.toMatchObject({ code: "INVALID_STATE" });
    } finally { await f.jobs.disconnect(); }
  });

  it("delivers cancellation to an outstanding event read and removes its listeners", async () => {
    // Given
    const f = await fixture();
    try {
      const reading = f.jobs.waitForChange("read", f.evaluate, 85000);
      await f.started;
      // When
      await f.jobs.cancel("read");
      // Then
      expect(await reading).toMatchObject({ state: "CANCELLED", executions: 0 });
      expect(getEventListeners(f.document, "__flashact_status__")).toHaveLength(0);
    } finally { await f.jobs.disconnect(); }
  });
});
