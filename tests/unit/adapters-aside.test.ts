import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { AsideAdapter } from "../../src/adapters/aside/index.js";
import { AsideTransport, decodeAsideOutput, execAside } from "../../src/adapters/aside/runner.js";
import type { AsideCommandRunner } from "../../src/adapters/aside/runner.js";
import { createAdapter } from "../../src/adapters/factory.js";
import { PlaywrightAdapter } from "../../src/adapters/playwright/index.js";

describe("Aside CLI boundary", () => {
  it("rejects URL ownership before invoking the CLI", async () => {
    // Given
    let calls = 0;
    const adapter = new AsideAdapter({ url: "http://127.0.0.1/task-owned" }, async () => { calls++; return ""; });
    // When / Then
    await expect(adapter.connect()).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
    expect(calls).toBe(0);
  });

  it("preserves code and option arguments when shell metacharacters are supplied", async () => {
    // Given
    const calls: { readonly executable: string; readonly args: readonly string[] }[] = [];
    const runner: AsideCommandRunner = async (executable, args) => {
      calls.push({ executable, args });
      const output: string[] = [];
      const code = args.at(-1);
      if (!code) throw new Error("Missing code fixture");
      await runInNewContext(`(async () => { ${code} })()`, { console: { log: (text: string) => output.push(text) } });
      return `\u001b[33mCLI status\u001b[0m\n${output.join("\n")}\nDone`;
    };
    const transport = new AsideTransport({ executable: "/native path/aside", account: "a;$(x)", host: "host 'quoted'" }, runner);
    // When
    const result = await transport.repl(`return ${JSON.stringify("quoted '\"; $(touch nope)\nUnicode 한글")};`);
    // Then
    expect(result).toBe("quoted '\"; $(touch nope)\nUnicode 한글");
    expect(calls[0]?.args.slice(0, 5)).toEqual(["repl", "--account", "a;$(x)", "--host", "host 'quoted'"]);
    expect(calls[0]?.executable).toBe("/native path/aside");
  });

  it.each(["status only", "marker{broken", 'marker{"kind":"unexpected"}', 'marker{"kind":"value"}', 'marker{"kind":"undefined"}\nmarker{"kind":"undefined"}'])("rejects invalid CLI output %s", (stdout) => {
    // Given / When / Then
    expect(() => decodeAsideOutput(stdout, "marker")).toThrow(expect.objectContaining({ code: "INVALID_RESPONSE" }));
  });

  it("keeps undefined results distinct from null", () => {
    // Given / When / Then
    expect(decodeAsideOutput('marker{"kind":"undefined"}', "marker")).toBeUndefined();
    expect(decodeAsideOutput('marker{"kind":"value","value":null}', "marker")).toBeNull();
  });

  it("reports browser exceptions without treating them as malformed output", () => {
    // Given / When / Then
    expect(() => decodeAsideOutput('marker{"kind":"error","message":"browser disconnected"}', "marker"))
      .toThrow(expect.objectContaining({ code: "ADAPTER_ERROR" }));
  });

  it("rejects a missing actual executable", async () => {
    // Given / When / Then
    await expect(execAside("/flashact-test-nonexistent/aside", ["--version"]))
      .rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  });

  it("uses list and attach APIs without opening tabs when connecting", async () => {
    // Given
    let opened = false;
    let attached: string | undefined;
    const runner: AsideCommandRunner = async (_executable, args) => {
      if (args[0] === "--version") return "1.26.1010.1739";
      const output: string[] = [];
      const code = args.at(-1);
      if (!code) throw new Error("Missing code fixture");
      await runInNewContext(`(async () => { ${code} })()`, {
        console: { log: (text: string) => output.push(text) },
        listBrowserTabs: async () => [{ targetId: "existing", url: "about:blank", title: "Existing" }],
        attachBrowserTab: async (id: string) => { attached = id; },
        openTab: async () => { opened = true; },
        snapshot: async () => ({ tree: "document", diff: "" }),
        page: { evaluate: async (expression: string) => runInNewContext(expression) },
      });
      return output.join("\n");
    };
    const adapter = new AsideAdapter({ tabId: "existing" }, runner);
    // When
    await adapter.connect();
    try {
      // Then
      expect(attached).toBe("existing");
      expect(opened).toBe(false);
      expect(await adapter.evaluate("1 + 2")).toBe(3);
      await expect(adapter.selectTab("not-an-exact-id")).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
    } finally { await adapter.disconnect(); }
  });
});

describe("adapter factory", () => {
  it("selects independent concrete backends", () => {
    // Given / When / Then
    expect(createAdapter("aside")).toBeInstanceOf(AsideAdapter);
    expect(createAdapter("playwright")).toBeInstanceOf(PlaywrightAdapter);
  });

  it("does not implicitly launch Playwright", async () => {
    // Given
    const adapter = createAdapter("playwright");
    // When / Then
    await expect(adapter.connect()).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  });
});
