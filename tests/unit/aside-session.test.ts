import { describe, expect, it, vi } from "vitest";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AsideSession } from "../../src/adapters/aside/session.js";

const fixture = new URL("../fixtures/aside-mcp-session.mjs", import.meta.url).pathname;

describe("persistent Aside MCP session", () => {
  it("retains one browser scope and producer across repeated typed reads", async () => {
    // Given
    const transport = new StdioClientTransport({ command: process.execPath, args: [fixture, "normal"], stderr: "pipe" });
    const session = new AsideSession({}, undefined, { transport: () => transport });
    try {
      await session.run("aside", ["--version"]);
      const pid = session.pid;
      // When
      const values = [await session.evaluate("tab", "globalThis.count = (globalThis.count ?? 0) + 1"),
        await session.evaluate("tab", "globalThis.count = (globalThis.count ?? 0) + 1")];
      // Then
      expect(values).toEqual([1, 2]);
      expect(session.pid).toBe(pid);
      await session.stop();
      expect(() => process.kill(pid ?? 0, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      await expect(session.evaluate("tab", "1")).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
    } finally { await session.stop(); }
  });

  it("preserves undefined and null through the actual MCP envelope", async () => {
    // Given
    const session = new AsideSession({}, undefined, { transport: () => new StdioClientTransport({
      command: process.execPath, args: [fixture, "normal"], stderr: "pipe",
    }) });
    try {
      // When / Then
      expect(await session.evaluate("tab", "undefined")).toBeUndefined();
      expect(await session.evaluate("tab", "null")).toBeNull();
    } finally { await session.stop(); }
  });

  it("joins a held actual MCP producer before a deadline releases its pending read", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "aside-mcp-held-"));
    const path = join(root, "started");
    let resolveStarted: () => void = () => {};
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const watcher = watch(root, (_event, name) => { if (name === "started") resolveStarted(); });
    const session = new AsideSession({}, undefined, { transport: () => new StdioClientTransport({
      command: process.execPath, args: [fixture, "ignore-term", path], stderr: "pipe",
    }) });
    let rejected: Promise<void> | undefined;
    try {
      await session.run("aside", ["--version"]);
      const pid = session.pid;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const reading = session.evaluate("tab", "__hold__");
      rejected = expect(reading).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
      await started;
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ pid });
      let settled = false;
      void reading.then(() => { settled = true; }, () => { settled = true; });
      // When
      await vi.advanceTimersByTimeAsync(5000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(4000);
      await session.stop();
      await rejected;
      // Then
      expect(() => process.kill(pid ?? 0, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    } finally {
      const stopped = session.stop();
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(4000);
      await stopped;
      await rejected;
      vi.useRealTimers();
      watcher.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
});
