import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { AsideAdapter } from "../../src/adapters/aside/index.js";
import type { AsideCommandRunner } from "../../src/adapters/aside/runner.js";

it("lists available tabs without attaching or snapshotting an unselected page", async () => {
  // Given
  let attachments = 0;
  let snapshots = 0;
  const runner: AsideCommandRunner = async (_executable, args) => {
    if (args[0] === "--version") return "1.26.1010.1739";
    const code = args.at(-1);
    if (!code) throw new Error("Missing REPL code");
    const output: string[] = [];
    await runInNewContext(`(async () => { ${code} })()`, {
      console: { log: (value: string) => output.push(value) },
      listBrowserTabs: async () => [{ targetId: "unselected", url: "https://private.example/", title: "Private tab" }],
      attachBrowserTab: async () => { attachments++; },
      snapshot: async () => { snapshots++; return { tree: "Private page", diff: "" }; },
      page: {},
    });
    return output.join("\n");
  };
  const adapter = new AsideAdapter({}, runner);
  try {
    // When
    await adapter.connect();
    const tabs = await adapter.listTabs();
    // Then
    expect(tabs).toEqual([{ id: "unselected", url: "https://private.example/", title: "Private tab" }]);
    expect(attachments).toBe(0);
    expect(snapshots).toBe(0);
    await expect(adapter.evaluate("1")).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
  } finally { await adapter.disconnect(); }
});
