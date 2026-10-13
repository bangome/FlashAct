import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { RuntimeJobs } from "../../src/adapters/playwright/runtime-jobs.js";
import type { ExecutionPlan, JobState, JobStatus } from "../../src/core/types.js";

const plan: ExecutionPlan = {
  schemaVersion: "1.0", jobId: "loss", name: "Transport loss", backend: "playwright",
  target: { tabId: "tab", selector: "#r", url: "about:blank" },
  trigger: { type: "SCHEDULED", at: 4_102_444_800_000 }, action: { type: "click" }, timezone: "UTC",
  expiresAt: 4_102_444_810_000, maxExecutions: 1, verification: { timeoutMs: 1_000 },
  guards: { approvedUrl: "about:blank", allowIrreversible: false },
};

async function installed(observesDispatch: boolean, initialState: JobState = "VALIDATED"): Promise<RuntimeJobs> {
  const status: JobStatus = { jobId: plan.jobId, state: initialState, executions: 0, updatedAt: Date.now() };
  const responses: unknown[] = [undefined, JSON.stringify({ jobId: plan.jobId, documentId: "document" }), undefined,
    JSON.stringify(status), JSON.stringify({ current: true, status: { ...status, state: "WAITING" } })];
  const jobs = new RuntimeJobs(async () => responses.shift(), observesDispatch);
  await jobs.install(plan);
  return jobs;
}

it.each([true, false])("retains unconfirmed armed uncertainty when transport is lost (observesDispatch=%s)", async observesDispatch => {
  // Given
  const jobs = await installed(observesDispatch);
  await jobs.arm(plan);
  // When
  jobs.invalidate(undefined, "disconnect");
  // Then
  expect(await jobs.status(plan.jobId)).toMatchObject({ state: "UNKNOWN", executions: 0 });
  await expect(jobs.arm(plan)).rejects.toMatchObject({ code: "INVALID_STATE" });
});

it("retains uncertainty when reconnecting to an already waiting document job before a new arm call", async () => {
  // Given
  const jobs = await installed(true, "WAITING");
  // When
  jobs.invalidate(undefined, "disconnect");
  // Then
  expect(await jobs.status(plan.jobId)).toMatchObject({ state: "UNKNOWN", executions: 0 });
  await expect(jobs.arm(plan)).rejects.toMatchObject({ code: "INVALID_STATE" });
});

it.each([true, false])("retains armed uncertainty when page close precedes disconnect (observesDispatch=%s)", async observesDispatch => {
  // Given
  const jobs = await installed(observesDispatch);
  await jobs.arm(plan);
  // When
  jobs.invalidate(plan.target.tabId, "close");
  jobs.invalidate(undefined, "disconnect");
  // Then
  expect(await jobs.status(plan.jobId)).toMatchObject({ state: "UNKNOWN", executions: 0 });
  await expect(jobs.arm(plan)).rejects.toMatchObject({ code: "INVALID_STATE" });
});

it.each(["CANCELLED", "VERIFIED", "EXPIRED", "INVALIDATED", "FAILED"] as const)("preserves confirmed runtime %s when close and disconnect follow", async state => {
  // Given
  const jobs = await installed(true);
  await jobs.arm(plan);
  const terminal: JobStatus = { jobId: plan.jobId, state, executions: state === "VERIFIED" ? 1 : 0, updatedAt: Date.now() };
  jobs.receive(jobs.eventMarker + JSON.stringify(terminal));
  // When
  jobs.invalidate(plan.target.tabId, "close");
  jobs.invalidate(undefined, "disconnect");
  // Then
  expect(await jobs.status(plan.jobId)).toEqual(terminal);
});

it.each([true, false])("retains definite unarmed failure when transport is lost (closeFirst=%s)", async closeFirst => {
  // Given
  const jobs = await installed(true);
  // When
  if (closeFirst) jobs.invalidate(plan.target.tabId, "close");
  jobs.invalidate(undefined, "disconnect");
  // Then
  expect(await jobs.status(plan.jobId)).toMatchObject({ state: "FAILED", executions: 0 });
});

function deferred<T>() {
  let resolveValue: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => { resolveValue = resolve; });
  return { promise, resolve(value: T): void {
    if (!resolveValue) throw new TypeError("Deferred resolver is not initialized");
    resolveValue(value);
  } };
}

async function controlled() {
  let current: JobStatus = { jobId: plan.jobId, state: "VALIDATED", executions: 0, updatedAt: 1 };
  let ready = false, wakeCalls = 0;
  const started = deferred<void>(), response = deferred<unknown>();
  let hold: "wake" | "status" | undefined;
  let called: "wake" | "status" | undefined;
  let captured: unknown;
  const runtime = {
    documentId: "document",
    install: () => ({ jobId: plan.jobId, documentId: "document" }),
    status: () => { called = "status"; return current; },
    arm: () => { current = { ...current, state: "WAITING", updatedAt: 2 }; return current; },
    cancel: () => { current = { ...current, state: "CANCELLED", updatedAt: 3 }; return current; },
    wake: () => {
      called = "wake";
      wakeCalls++;
      if (ready && current.state === "WAITING") current = { ...current, state: "VERIFIED", executions: 1, updatedAt: 4 };
      return current;
    },
  };
  let observer: RuntimeJobs | undefined;
  const realm = { __flashactRuntime: runtime, window: new EventTarget(),
    console: { log: (text: string) => { observer?.receive(text); } } };
  const expressions: string[] = [];
  const jobs = new RuntimeJobs(async (_tabId, expression) => {
    expressions.push(expression);
    called = undefined;
    const value: unknown = runInNewContext(expression, realm);
    if (hold && called === hold) {
      hold = undefined;
      captured = value;
      started.resolve();
      return response.promise;
    }
    return value;
  });
  observer = jobs;
  await jobs.install(plan);
  return { jobs, realm, expressions, started, response,
    hold(method: "wake" | "status") { hold = method; },
    ready() { ready = true; },
    release() { response.resolve(captured); },
    get wakeCalls() { return wakeCalls; },
  };
}

it("binds wake and its command in one realm task and rejects replacement identity", async () => {
  // Given
  const fixture = await controlled();
  await fixture.jobs.arm(plan);
  const before = fixture.expressions.length;
  // When
  expect(await fixture.jobs.wake(plan.jobId)).toMatchObject({ state: "WAITING", executions: 0 });
  // Then: waiting wake requires exactly one bound command, not a separate preflight.
  expect(fixture.expressions.length - before).toBe(1);
  fixture.realm.__flashactRuntime = { ...fixture.realm.__flashactRuntime };
  await expect(fixture.jobs.wake(plan.jobId)).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(fixture.wakeCalls).toBe(1);
});

it("does not let a delayed wake undo confirmed cancellation", async () => {
  // Given: execute an early wake but retain its WAITING response behind a barrier.
  const fixture = await controlled();
  await fixture.jobs.arm(plan);
  fixture.hold("wake");
  const waking = fixture.jobs.wake(plan.jobId);
  await fixture.started.promise;
  // When
  await fixture.jobs.cancel(plan.jobId);
  fixture.release();
  // Then
  expect(await waking).toMatchObject({ state: "CANCELLED", executions: 0 });
  expect(await fixture.jobs.status(plan.jobId)).toMatchObject({ state: "CANCELLED", executions: 0 });
});

it("retains a recorded dispatch against delayed status and console snapshots", async () => {
  // Given
  const fixture = await controlled();
  await fixture.jobs.arm(plan);
  fixture.hold("status");
  const checking = fixture.jobs.status(plan.jobId);
  await fixture.started.promise;
  const dispatched: JobStatus = { jobId: plan.jobId, state: "DISPATCHED", executions: 1, updatedAt: 5 };
  // When
  fixture.jobs.receive(fixture.jobs.eventMarker + JSON.stringify(dispatched));
  fixture.jobs.receive(fixture.jobs.eventMarker + JSON.stringify({ ...dispatched, state: "WAITING", executions: 0, updatedAt: 2 }));
  fixture.release();
  // Then
  expect(await checking).toEqual(dispatched);
});

it("retains loss-induced UNKNOWN and later execution evidence without retry", async () => {
  // Given: a real captured execution reply is withheld until after disconnect.
  const fixture = await controlled();
  await fixture.jobs.arm(plan);
  fixture.ready();
  fixture.hold("wake");
  const waking = fixture.jobs.wake(plan.jobId);
  await fixture.started.promise;
  // When
  fixture.jobs.invalidate(undefined, "disconnect");
  fixture.release();
  // Then
  expect(await waking).toMatchObject({ state: "UNKNOWN", executions: 1 });
  await expect(fixture.jobs.wake(plan.jobId)).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(fixture.wakeCalls).toBe(1);
});

it("rejects a missing wake without evaluating or installing anything", async () => {
  const fixture = await controlled();
  const before = fixture.expressions.length;
  await expect(fixture.jobs.wake("missing")).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
  expect(fixture.expressions.length).toBe(before);
});

it("does not attribute a replacement runtime's click report to the installed job", async () => {
  // Given
  const fixture = await controlled();
  await fixture.jobs.arm(plan);
  fixture.realm.__flashactRuntime = { ...fixture.realm.__flashactRuntime,
    status: (): JobStatus => ({ jobId: plan.jobId, state: "VERIFIED", executions: 1, updatedAt: 9 }) };
  // When
  fixture.realm.window.dispatchEvent(new Event("click"));
  // Then
  expect(await fixture.jobs.status(plan.jobId)).toMatchObject({ state: "INVALIDATED", executions: 0 });
});
