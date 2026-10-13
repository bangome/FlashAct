import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { PlaywrightAdapter } from "../../src/adapters/playwright/index.js";

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
