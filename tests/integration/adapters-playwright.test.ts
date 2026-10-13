import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { PlaywrightAdapter } from "../../src/adapters/playwright/index.js";
import type { ExecutionPlan } from "../../src/core/types.js";

const fixtureUrl = `data:text/html,${encodeURIComponent('<button id="go" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1);document.body.insertAdjacentHTML(\'beforeend\',\'<span id=done>Done</span>\')">Go</button>')}`;

function plan(tabId: string, overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    schemaVersion: "1.0", jobId: "adapter-job", name: "Adapter fixture", backend: "playwright",
    target: { tabId, selector: "#go", url: fixtureUrl },
    trigger: { type: "ELEMENT_ENABLE", selector: "#go" }, action: { type: "click" }, timezone: "UTC",
    expiresAt: Date.now() + 60_000, maxExecutions: 1,
    verification: { selector: "#done", timeoutMs: 10_000 },
    guards: { approvedUrl: fixtureUrl, allowIrreversible: false }, ...overrides,
  };
}

async function selectedId(adapter: PlaywrightAdapter): Promise<string> {
  const tabs = await adapter.listTabs();
  const id = tabs[0]?.id;
  if (!id) throw new Error("Owned fixture tab missing");
  return id;
}

describe("real Playwright adapter", () => {
  it("installs separately and dispatches exactly once when armed", async () => {
    // Given
    const adapter = new PlaywrightAdapter({ launch: true, url: fixtureUrl });
    await adapter.connect();
    try {
      const input = plan(await selectedId(adapter));
      await adapter.installRuntime(input);
      expect(await adapter.evaluate("document.body.dataset.clicks")).toBeUndefined();
      // When
      await adapter.arm(input);
      await adapter.arm(input);
      // Then
      expect(await adapter.getStatus(input.jobId)).toMatchObject({ state: "VERIFIED", executions: 1 });
      expect(await adapter.evaluate("document.body.dataset.clicks")).toBe("1");
      expect(await adapter.inspectTarget("#go")).toMatchObject({ count: 1, enabled: true, visible: true });
    } finally { await adapter.disconnect(); }
  });

  it("preserves all supplied contexts and cookies when disconnected", async () => {
    // Given
    const browser = await chromium.launch();
    const first = await browser.newContext();
    const second = await browser.newContext();
    const page = await first.newPage();
    await second.newPage();
    await first.addCookies([{ name: "fixture", value: "retained", url: "http://127.0.0.1" }]);
    const adapter = new PlaywrightAdapter({ page });
    try {
      await adapter.connect();
      const initial = await adapter.listTabs();
      expect(initial).toHaveLength(2);
      expect(await adapter.listTabs()).toEqual(initial);
      await expect(adapter.selectTab("approximate-id")).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
      // When
      await adapter.disconnect();
      // Then
      expect(browser.isConnected()).toBe(true);
      expect(page.isClosed()).toBe(false);
      expect(await first.cookies()).toEqual([expect.objectContaining({ name: "fixture", value: "retained" })]);
    } finally { await adapter.disconnect(); await browser.close(); }
  });

  it("invalidates pending work after navigation without re-arming", async () => {
    // Given
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(fixtureUrl);
    const adapter = new PlaywrightAdapter({ page });
    await adapter.connect();
    try {
      const input = plan(await selectedId(adapter), { trigger: { type: "SCHEDULED", at: Date.now() + 30_000 } });
      await adapter.installRuntime(input);
      await adapter.arm(input);
      // When
      await page.goto("about:blank");
      // Then
      expect(await adapter.getStatus(input.jobId)).toMatchObject({ state: "INVALIDATED", executions: 0 });
      await expect(adapter.arm(input)).rejects.toMatchObject({ code: "INVALID_STATE" });
    } finally { await adapter.disconnect(); await browser.close(); }
  });

  it("retains UNKNOWN when a dispatched job loses its document", async () => {
    // Given
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(fixtureUrl);
    const adapter = new PlaywrightAdapter({ page });
    await adapter.connect();
    try {
      const input = plan(await selectedId(adapter), { verification: { selector: "#never", timeoutMs: 10_000 } });
      await adapter.installRuntime(input);
      await adapter.arm(input);
      // When
      await page.goto("about:blank");
      // Then
      expect(await adapter.getStatus(input.jobId)).toMatchObject({ state: "UNKNOWN", executions: 1 });
    } finally { await adapter.disconnect(); await browser.close(); }
  });

  it("retains UNKNOWN when an armed browser disconnects without confirmed cancellation", async () => {
    // Given
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(fixtureUrl);
    const adapter = new PlaywrightAdapter({ page });
    await adapter.connect();
    try {
      const input = plan(await selectedId(adapter), { trigger: { type: "SCHEDULED", at: Date.now() + 30_000 } });
      await adapter.installRuntime(input);
      await adapter.arm(input);
      // When
      await browser.close();
      // Then
      expect(await adapter.getStatus(input.jobId)).toMatchObject({ state: "UNKNOWN", executions: 0 });
      await expect(adapter.arm(input)).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
    } finally { await adapter.disconnect(); await browser.close(); }
  });

  it("detects a replaced runtime even in the same document", async () => {
    // Given
    const adapter = new PlaywrightAdapter({ launch: true, url: fixtureUrl });
    await adapter.connect();
    try {
      const input = plan(await selectedId(adapter));
      await adapter.installRuntime(input);
      // When
      await adapter.evaluate("delete globalThis.__flashactRuntime");
      // Then
      expect(await adapter.getStatus(input.jobId)).toMatchObject({ state: "INVALIDATED", executions: 0 });
    } finally { await adapter.disconnect(); }
  });

  it("cancels pending work before releasing a supplied page", async () => {
    // Given
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(fixtureUrl);
    const adapter = new PlaywrightAdapter({ page });
    await adapter.connect();
    try {
      const input = plan(await selectedId(adapter), { trigger: { type: "SCHEDULED", at: Date.now() + 30_000 } });
      await adapter.installRuntime(input);
      await adapter.arm(input);
      // When
      await adapter.disconnect();
      // Then
      expect(await adapter.getStatus(input.jobId)).toMatchObject({ state: "CANCELLED", executions: 0 });
      expect(page.isClosed()).toBe(false);
    } finally { await adapter.disconnect(); await browser.close(); }
  });

  it("captures local dispatch before navigation when no host status query has occurred", async () => {
    // Given
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(fixtureUrl);
    await page.locator("#go").evaluate((element) => element.setAttribute("disabled", ""));
    const adapter = new PlaywrightAdapter({ page });
    await adapter.connect();
    try {
      const input = plan(await selectedId(adapter), { verification: { selector: "#never", timeoutMs: 10_000 } });
      await adapter.installRuntime(input);
      await adapter.arm(input);
      // When
      await page.locator("#go").evaluate((element) => element.removeAttribute("disabled"));
      await page.goto("about:blank");
      // Then
      expect(await adapter.getStatus(input.jobId)).toMatchObject({ state: "UNKNOWN", executions: 1 });
    } finally { await adapter.disconnect(); await browser.close(); }
  });

  it("keeps independent handles for multiple installed jobs in one document", async () => {
    // Given
    const adapter = new PlaywrightAdapter({ launch: true, url: fixtureUrl });
    await adapter.connect();
    try {
      const id = await selectedId(adapter);
      const first = plan(id, { jobId: "first", trigger: { type: "SCHEDULED", at: Date.now() + 30_000 } });
      const second = plan(id, { jobId: "second", trigger: { type: "SCHEDULED", at: Date.now() + 30_000 } });
      await adapter.installRuntime(first);
      await adapter.installRuntime(second);
      // When
      await adapter.arm(first);
      await adapter.cancel(first.jobId);
      // Then
      expect(await adapter.getStatus(first.jobId)).toMatchObject({ state: "CANCELLED" });
      expect(await adapter.getStatus(second.jobId)).toMatchObject({ state: "VALIDATED" });
    } finally { await adapter.disconnect(); }
  });
});
