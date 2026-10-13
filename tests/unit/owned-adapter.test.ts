import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { OwnedPlaywrightAdapter } from "../../src/adapters/playwright/owned.js";
import { ChromeOwner } from "../../src/adapters/playwright/chrome-owner.js";
import { createOwnedAdapter } from "../../src/adapters/factory.js";
import type { ExecutionPlan, JobStatus } from "../../src/core/types.js";
import { eventSchema } from "../../src/adapters/playwright/worker-protocol.js";

const plan: ExecutionPlan = {
  schemaVersion: "1.0", jobId: "held", name: "Held operation", backend: "playwright",
  target: { tabId: "fixture-tab", selector: "#go", url: "about:blank" },
  trigger: { type: "SCHEDULED", at: 4_102_444_800_000 }, action: { type: "click" }, timezone: "UTC",
  expiresAt: 4_102_444_810_000, maxExecutions: 1, verification: { timeoutMs: 1_000 },
  guards: { approvedUrl: "about:blank", allowIrreversible: false },
};

function fixture(mode?: string) {
  const sequence: string[] = [];
  let worker: Worker | undefined;
  let artifactsDir: string | undefined;
  const adapter = new OwnedPlaywrightAdapter({ endpoint: "http://127.0.0.1:1" }, {
    worker: (_url, initialization) => {
      if (typeof initialization !== "object" || initialization === null) throw new TypeError("Fixture initialization missing");
      if ("artifactsDir" in initialization && typeof initialization.artifactsDir === "string") artifactsDir = initialization.artifactsDir;
      worker = new Worker(new URL("./owned-adapter-worker.mjs", import.meta.url), {
        workerData: { ...initialization, fixture: mode }, stdout: true, stderr: true,
      });
      worker.once("exit", () => sequence.push("exit"));
      return worker;
    },
  });
  return { adapter, sequence, get worker() { if (!worker) throw new TypeError("Worker not acquired"); return worker; },
    get artifactsDir() { if (!artifactsDir) throw new TypeError("Artifacts not acquired"); return artifactsDir; } };
}

function observed(adapter: OwnedPlaywrightAdapter, predicate: (status: JobStatus) => boolean): Promise<JobStatus> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error("Retained observation barrier missing")); }, 10_000);
    const unsubscribe = adapter.owner.subscribe(status => {
      if (!predicate(status)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(status);
    });
  });
}

it.each(["hold", "hold-execution"])("joins a real withheld producer before rejecting %s and keeps observations", async argument => {
  // Given
  const controlled = fixture();
  const { adapter, sequence } = controlled;
  await adapter.connect();
  await adapter.installRuntime(plan);
  await adapter.arm(plan);
  const started = observed(adapter, status => status.updatedAt === 123);
  const pending = adapter.evaluate(argument).catch((error: unknown) => { sequence.push("rejection"); throw error; });
  const rejected = expect(pending).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  await started;
  const artifacts = controlled.artifactsDir;
  // When
  const stop = adapter.owner.stop("cancel");
  expect(adapter.owner.stop("shutdown")).toBe(stop);
  await expect(adapter.listTabs()).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  const statuses = await stop;
  await rejected;
  // Then
  expect(sequence).toEqual(["exit", "rejection"]);
  expect(statuses).toEqual([expect.objectContaining({ state: "UNKNOWN", executions: argument === "hold-execution" ? 1 : 0 })]);
  await expect(readdir(artifacts)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(adapter.connect()).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
});

it("admits wake and cancel while a status producer has withheld its reply", async () => {
  // Given
  const { adapter } = fixture();
  await adapter.connect();
  await adapter.installRuntime(plan);
  await adapter.arm(plan);
  const started = observed(adapter, status => status.updatedAt === 123);
  const checking = adapter.getStatus(plan.jobId);
  const rejected = expect(checking).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  await started;
  try {
    // When
    expect(await adapter.wake(plan.jobId)).toMatchObject({ state: "WAITING" });
    await adapter.cancel(plan.jobId);
    // Then
    expect(await adapter.owner.stop("cancel")).toEqual([expect.objectContaining({ state: "CANCELLED", executions: 0 })]);
    await rejected;
  } finally { await adapter.owner.stop("shutdown"); }
});

it("forces cancellation at its own deadline independently of a held status request", async () => {
  // Given
  const { adapter, sequence } = fixture("held-cancel");
  await adapter.connect();
  await adapter.installRuntime(plan);
  await adapter.arm(plan);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const started = observed(adapter, status => status.updatedAt === 123);
    const checking = adapter.getStatus(plan.jobId).catch((error: unknown) => { sequence.push("rejection"); throw error; });
    const rejected = expect(checking).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
    await started;
    const cancelling = observed(adapter, status => status.updatedAt === 124);
    const cancelled = adapter.cancel(plan.jobId);
    const cancelRejected = expect(cancelled).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
    await cancelling;
    // When
    vi.advanceTimersByTime(2_000);
    await rejected;
    await cancelRejected;
    await adapter.owner.stop("shutdown");
    // Then
    expect(sequence).toEqual(["exit", "rejection"]);
  } finally { vi.useRealTimers(); await adapter.owner.stop("shutdown"); }
});

it.each(["initialization-failure", "connect-failure"])("cleans actual worker and artifacts after %s", async mode => {
  // Given
  const controlled = fixture(mode);
  // When
  await expect(controlled.adapter.connect()).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  await controlled.adapter.owner.stop("shutdown");
  // Then
  expect(controlled.sequence).toEqual(["exit"]);
  await expect(readdir(controlled.artifactsDir)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["operation", "disconnect"] as const)("joins a held worker at the independent %s deadline", async mode => {
  // Given
  const { adapter, sequence } = fixture(mode === "disconnect" ? "held-disconnect" : undefined);
  await adapter.connect();
  await adapter.installRuntime(plan);
  await adapter.arm(plan);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const started = observed(adapter, status => status.updatedAt === 123);
    const checking = adapter.getStatus(plan.jobId).catch((error: unknown) => { sequence.push("rejection"); throw error; });
    const rejected = expect(checking).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
    await started;
    let disconnecting: Promise<void> | undefined;
    if (mode === "disconnect") {
      const cleaning = observed(adapter, status => status.updatedAt === 125);
      disconnecting = adapter.disconnect();
      await cleaning;
    }
    // When
    vi.advanceTimersByTime(mode === "disconnect" ? 2_000 : 5_000);
    await rejected;
    await disconnecting;
    const snapshot = await adapter.owner.stop("shutdown");
    // Then
    expect(sequence).toEqual(["exit", "rejection"]);
    expect(snapshot).toEqual([expect.objectContaining({ state: mode === "disconnect" ? "CANCELLED" : "UNKNOWN" })]);
  } finally { vi.useRealTimers(); await adapter.owner.stop("shutdown"); }
});

it("seals acquisition before a temporary root acknowledgement can publish a worker", async () => {
  // Given
  const controlled = fixture();
  const connecting = controlled.adapter.connect();
  const rejected = expect(connecting).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  // When
  await controlled.adapter.owner.stop("shutdown");
  await rejected;
  // Then
  expect(controlled.sequence).toEqual([]);
});

it.each([
  {}, { launch: true, endpoint: "http://127.0.0.1:1" },
  { endpoint: "http://127.0.0.1:1", url: "about:blank" },
  { launch: true, userDataDir: "/borrowed" }, { launch: true, page: {} },
  { launch: true, context: {} },
])("rejects incompatible owned options before acquisition: %j", options => {
  // Given / When / Then
  expect(() => createOwnedAdapter("playwright", options)).toThrow(expect.objectContaining({ code: "ADAPTER_ERROR" }));
});

it("rejects raw and unknown worker envelope fields", () => {
  // Given / When / Then
  expect(eventSchema.safeParse({ kind: "error", generation: "bad", id: 1, code: "ADAPTER_ERROR", message: "raw" }).success).toBe(false);
  expect(eventSchema.safeParse({ kind: "console", text: "private" }).success).toBe(false);
});

it("joins root exit and stdio close after recorded process-group escalation", async () => {
  // Given
  const profile = await mkdtemp(join(tmpdir(), "owned-group-test-"));
  let started: Promise<unknown[]> | undefined;
  let term: Promise<unknown[]> | undefined;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const chrome = new ChromeOwner(profile, true, () => {
    const child = spawn(process.execPath, [new URL("./owned-adapter-process.mjs", import.meta.url).pathname,
      "ignore-term", `started-path=${join(profile, "started")}`], {
      detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    started = once(child, "message");
    return child;
  });
  try {
    await started;
    term = once(chrome.child, "message");
    const events: string[] = [];
    chrome.child.once("exit", () => events.push("exit"));
    chrome.child.once("close", () => events.push("close"));
    // When
    const stopping = chrome.stop().then(() => { events.push("joined"); });
    expect((await term)[0]).toBe("term");
    vi.advanceTimersByTime(2_000);
    await stopping;
    // Then
    expect(events).toEqual(["exit", "close", "joined"]);
    expect(chrome.child.signalCode).toBe("SIGKILL");
  } finally {
    const cleanup = chrome.stop();
    vi.advanceTimersByTime(2_000);
    await cleanup;
    vi.useRealTimers();
    await rm(profile, { recursive: true, force: true });
  }
});

it("does not mistake a root exit for inherited stdio close", async () => {
  // Given
  const profile = await mkdtemp(join(tmpdir(), "owned-stdio-test-"));
  let started: Promise<unknown[]> | undefined;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const chrome = new ChromeOwner(profile, true, () => {
    const child = spawn(process.execPath, [new URL("./owned-adapter-process.mjs", import.meta.url).pathname, "held-stdio"], {
      detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    started = new Promise((resolve, reject) => {
      child.on("message", message => { if (message === "descendant-started") resolve([message]); });
      child.once("error", reject);
    });
    return child;
  });
  try {
    await started;
    await chrome.exited;
    const events: string[] = [];
    chrome.child.once("close", () => events.push("close"));
    // When
    const stopping = chrome.stop().then(() => { events.push("joined"); });
    vi.advanceTimersByTime(2_000);
    await stopping;
    // Then
    expect(events).toEqual(["close", "joined"]);
  } finally {
    const cleanup = chrome.stop();
    vi.advanceTimersByTime(2_000);
    await cleanup;
    vi.useRealTimers();
    await rm(profile, { recursive: true, force: true });
  }
});

it("joins an acquisition stopped after the worker has started connecting", async () => {
  // Given: a file event is a fixture-only started barrier, not a product protocol operation.
  const root = await mkdtemp(join(tmpdir(), "owned-connect-barrier-"));
  const startedPath = join(root, "started");
  let resolveStarted: () => void = () => {};
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  const watcher = watch(root, (_event, name) => { if (name === "started") resolveStarted(); });
  const adapter = new OwnedPlaywrightAdapter({ endpoint: "http://127.0.0.1:1" }, {
    worker: (_url, initialization) => {
      if (typeof initialization !== "object" || initialization === null) throw new TypeError("Fixture initialization missing");
      return new Worker(new URL("./owned-adapter-worker.mjs", import.meta.url), {
        workerData: { ...initialization, fixture: "held-connect", startedPath },
      });
    },
  });
  try {
    const connecting = adapter.connect();
    const rejected = expect(connecting).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
    await started;
    // When
    await adapter.owner.stop("shutdown");
    await rejected;
    // Then
    await expect(adapter.connect()).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  } finally { watcher.close(); await adapter.owner.stop("shutdown"); await rm(root, { recursive: true, force: true }); }
});

it("joins and removes a partially acquired Chrome before returning the owner snapshot", async () => {
  // Given
  let resolveStarted: () => void = () => {};
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  let chrome: ChromeOwner | undefined;
  let profile: string | undefined;
  const adapter = new OwnedPlaywrightAdapter({ launch: true, headless: true }, {
    chrome: directory => {
      profile = directory;
      chrome = new ChromeOwner(directory, true, () => {
        const child = spawn(process.execPath, [new URL("./owned-adapter-process.mjs", import.meta.url).pathname], {
          detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        child.once("message", () => resolveStarted());
        return child;
      });
      return chrome;
    },
  });
  const connecting = adapter.connect();
  const rejected = expect(connecting).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  await started;
  try {
    // When
    await adapter.owner.stop("cancel");
    await rejected;
    // Then
    if (!chrome || !profile) throw new TypeError("Partial Chrome was not acquired");
    await chrome.exited;
    await chrome.closed;
    expect(chrome.child.exitCode).toBe(0);
    await expect(readdir(profile)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await adapter.owner.stop("shutdown"); }
});
