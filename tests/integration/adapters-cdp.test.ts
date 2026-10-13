import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { PlaywrightAdapter } from "../../src/adapters/playwright/index.js";
import type { createOwnedAdapter as OwnedFactory } from "../../src/adapters/factory.js";
import { ChromeOwner } from "../../src/adapters/playwright/chrome-owner.js";

const { createOwnedAdapter }: { readonly createOwnedAdapter: typeof OwnedFactory } =
  await import(new URL("../../dist/adapters/factory.js", import.meta.url).href);

it("uses actual CDP target IDs and leaves an attached browser alive on disconnect", async () => {
  // Given
  const profile = await mkdtemp(join(tmpdir(), "flashact-cdp-"));
  const child = spawn(chromium.executablePath(), ["--headless", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let attached: PlaywrightAdapter | undefined;
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => reject(new Error("CDP fixture startup timed out")), 30_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("CDP fixture exited before startup")); });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
        if (match?.[1]) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    attached = new PlaywrightAdapter({ endpoint });
    await attached.connect();
    const tabs = await attached.listTabs();
    const tab = tabs[0];
    if (!tab) throw new Error("CDP fixture page missing");
    const connection = await chromium.connectOverCDP(endpoint);
    try {
      const context = connection.contexts()[0];
      const page = context?.pages()[0];
      if (!context || !page) throw new Error("CDP fixture context missing");
      const session = await context.newCDPSession(page);
      try {
        const response = await session.send("Target.getTargetInfo");
        expect(tab.id).toBe(response.targetInfo.targetId);
      } finally { await session.detach(); }
      await context.addCookies([{ name: "cdp-fixture", value: "original", url: "http://127.0.0.1" }]);
      await attached.selectTab(tab.id);
      // When
      await attached.disconnect();
      // Then
      expect(connection.isConnected()).toBe(true);
      expect(await page.evaluate("2 + 3")).toBe(5);
      expect(await context.cookies()).toEqual([expect.objectContaining({ name: "cdp-fixture", value: "original" })]);
    } finally { await connection.close(); }
  } finally {
    await attached?.disconnect();
    child.kill("SIGTERM");
    await exited;
    await rm(profile, { recursive: true, force: true });
  }
}, 45_000);

it.each(["graceful", "forced"] as const)("preserves a borrowed local endpoint and existing context on %s owner exit", async mode => {
  // Given: the test, not the product, owns this exact Chrome group/profile.
  const profile = await mkdtemp(join(tmpdir(), "owned-borrowed-endpoint-"));
  const chrome = new ChromeOwner(profile, true);
  let connection: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let adapter: ReturnType<typeof createOwnedAdapter> | undefined;
  try {
    const endpoint = await chrome.endpoint;
    connection = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    const context = connection.contexts()[0];
    const page = context?.pages()[0];
    if (!context || !page) throw new Error("Borrowed fixture context missing");
    await context.addCookies([{ name: "borrowed-owner", value: "retained", url: "http://127.0.0.1" }]);
    const initialUrl = page.url();
    const pages = context.pages();
    adapter = createOwnedAdapter("playwright", { endpoint });
    await adapter.connect();
    // When
    if (mode === "graceful") await adapter.disconnect();
    else await adapter.owner.stop("deadline");
    // Then
    expect(adapter.owner.kind).toBe("endpoint-client");
    expect(chrome.child.exitCode).toBeNull();
    expect(chrome.child.signalCode).toBeNull();
    expect(connection.isConnected()).toBe(true);
    expect(context.pages()).toEqual(pages);
    expect(page.url()).toBe(initialUrl);
    expect(await page.evaluate("2 + 3")).toBe(5);
    expect(await context.cookies()).toEqual([expect.objectContaining({ name: "borrowed-owner", value: "retained" })]);
  } finally {
    await adapter?.owner.stop("shutdown");
    await connection?.close();
    await chrome.stop();
    await rm(profile, { recursive: true, force: true });
  }
}, 45_000);

it("uses an explicitly requested persistent profile without copying cookies", async () => {
  // Given
  const profile = await mkdtemp(join(tmpdir(), "flashact-persistent-"));
  const server = createServer((_request, response) => response.end("<button id=fixture>Fixture</button>"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local fixture address missing");
  const url = `http://127.0.0.1:${address.port}`;
  const first = new PlaywrightAdapter({ launch: true, userDataDir: profile, url });
  const second = new PlaywrightAdapter({ launch: true, userDataDir: profile, url });
  try {
    await first.connect();
    await first.evaluate('document.cookie = "persistent-fixture=retained; Max-Age=600; SameSite=Lax"');
    await first.disconnect();
    // When
    await second.connect();
    // Then
    expect(await second.evaluate("document.cookie")).toContain("persistent-fixture=retained");
  } finally {
    await first.disconnect();
    await second.disconnect();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(profile, { recursive: true, force: true });
  }
}, 45_000);
