import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { expect, it } from "vitest";
import { PlaywrightAdapter } from "../../src/adapters/playwright/index.js";
import { JobEngine } from "../../src/core/engine.js";
import type { ExecutionPlan, JobStatus } from "../../src/core/types.js";

it("retains UNKNOWN without rearming when a disconnected CDP client leaves the armed page alive", async () => {
  // Given: an externally owned browser and two independent public CDP clients.
  const profile = await mkdtemp(join(tmpdir(), "flashact-transport-loss-"));
  const child = spawn(chromium.executablePath(), ["--headless", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let control: Browser | undefined;
  let observer: Browser | undefined;
  let engine: JobEngine | undefined;
  const receipt: {
    targetEpochMs?: number; armed?: JobStatus; beforeTarget?: JobStatus; afterClick?: JobStatus;
    adapterStatus?: JobStatus; independentClicks?: unknown; observerConnected?: boolean;
    rearmRejected?: boolean; outcome?: string; failure?: string;
    cleanup: { clientsClosed: boolean; engineClosed: boolean; profileRemoved: boolean; chromeExit?: { readonly code: number | null; readonly signal: string | null } };
  } = { cleanup: { clientsClosed: false, engineClosed: false, profileRemoved: false } };
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => reject(new Error("CDP fixture startup timed out")), 30_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("CDP fixture exited before startup")); });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
        if (match?.[1]) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    control = await chromium.connectOverCDP(endpoint);
    observer = await chromium.connectOverCDP(endpoint);
    const controlPage = control.contexts()[0]?.pages()[0];
    const observerPage = observer.contexts()[0]?.pages()[0];
    if (!controlPage || !observerPage) throw new Error("Owned CDP fixture page missing");
    await controlPage.setContent('<script>window.clicks=0</script><button type="button" id="r" onclick="window.clicks++">Click</button>');
    const adapter = new PlaywrightAdapter({ page: controlPage });
    engine = new JobEngine({ adapters: { playwright: adapter } });
    const tab = (await engine.listTabs("playwright"))[0];
    if (!tab) throw new Error("Owned adapter tab missing");
    const at = Date.now() + 2_000;
    receipt.targetEpochMs = at;
    const plan: ExecutionPlan = {
      schemaVersion: "1.0", jobId: "transport-loss", name: "Owned CDP transport loss", backend: "playwright",
      target: { tabId: tab.id, selector: "#r", url: "about:blank" },
      trigger: { type: "SCHEDULED", at }, action: { type: "click" }, timezone: "UTC",
      expiresAt: at + 10_000, maxExecutions: 1, verification: { timeoutMs: 1_000 },
      guards: { approvedUrl: "about:blank", allowIrreversible: false },
    };
    await engine.createJob(plan);
    expect(await engine.validateJob(plan.jobId)).toMatchObject({ state: "VALIDATED", executions: 0 });
    receipt.armed = await engine.armJob(plan.jobId);
    expect(receipt.armed).toMatchObject({ state: "ARMED", executions: 0 });
    expect(await observerPage.evaluate("window.clicks")).toBe(0);

    // When: public close disconnects only the control client, not Chromium.
    await control.close();
    receipt.beforeTarget = await engine.getStatus(plan.jobId);
    await observerPage.waitForFunction("window.clicks === 1", undefined, { timeout: 15_000 });
    receipt.independentClicks = await observerPage.evaluate("window.clicks");
    receipt.observerConnected = observer.isConnected();
    receipt.afterClick = await engine.getStatus(plan.jobId);
    receipt.adapterStatus = await adapter.getStatus(plan.jobId);

    // Then: zero is the host's last observation, not proof of no effect.
    expect(receipt.beforeTarget.updatedAt).toBeLessThan(at);
    expect(receipt.beforeTarget).toMatchObject({ state: "UNKNOWN", executions: 0 });
    expect(receipt.afterClick).toEqual(receipt.beforeTarget);
    expect(receipt.adapterStatus).toMatchObject({ state: "UNKNOWN", executions: 0 });
    expect(receipt.independentClicks).toBe(1);
    expect(receipt.observerConnected).toBe(true);
    await expect(engine.armJob(plan.jobId)).rejects.toMatchObject({ code: "INVALID_STATE" });
    receipt.rearmRejected = true;
    receipt.outcome = "passed";
  } catch (error) {
    receipt.outcome = "failed";
    if (error instanceof Error) receipt.failure = error.message;
    throw error;
  } finally {
    try {
      await engine?.close();
      receipt.cleanup.engineClosed = true;
    } finally {
      try {
        await control?.close();
        await observer?.close();
        receipt.cleanup.clientsClosed = true;
      } finally {
        child.kill("SIGTERM");
        receipt.cleanup.chromeExit = await exited;
        await rm(profile, { recursive: true, force: true });
        receipt.cleanup.profileRemoved = true;
        await writeFile("artifacts/qa/transport-loss-after.json", JSON.stringify({
          real: true, recordedAt: new Date().toISOString(),
          command: "npm test -- tests/integration/adapters-transport-loss.test.ts", receipt,
          assumptionFinding: "Armed unconfirmed zero after CDP transport loss is not proof of no click; the old FAILED expectation was incorrect.",
          touchedFiles: ["src/adapters/playwright/runtime-jobs.ts", "tests/integration/adapters-playwright.test.ts", "tests/integration/adapters-transport-loss.test.ts", "tests/unit/adapters-runtime-jobs.test.ts"],
        }, null, 2) + "\n");
      }
    }
  }
}, 45_000);
