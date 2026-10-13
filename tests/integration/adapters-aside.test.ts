import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AsideAdapter } from "../../src/adapters/aside/index.js";
import { AsideTransport, execAside } from "../../src/adapters/aside/runner.js";
import { parsePlan } from "../../src/core/schema.js";
import type { ExecutionPlan, JobStatus, Trigger } from "../../src/core/types.js";
import { FlashActError, assertNever } from "../../src/utils/errors.js";
import { AsideFixtureOwner } from "./adapters-aside-owner.js";

const receiptSchema = z.object({ id: z.string(), epochMs: z.coerce.number().finite().nonnegative() });
type Receipt = z.infer<typeof receiptSchema>;

describe.runIf(process.env["FLASHACT_ASIDE_INTEGRATION"] === "1")("real Aside common-plan adapter", () => {
  const nonce = randomUUID();
  const transport = new AsideTransport({});
  const operations: { readonly name: string; readonly ms: number }[] = [];
  const scenarios: { readonly name: string; readonly plan: ExecutionPlan; readonly status: JobStatus; readonly receipt?: Receipt; readonly latencyMs?: number }[] = [];
  const listeners = new Map<string, (receipt: Receipt) => void>();
  const receipts: Receipt[] = [];
  let url = "";
  let tabId = "";
  let version = "";
  let owner: AsideFixtureOwner | undefined;
  let adapter: AsideAdapter | undefined;
  let closedTab = false;
  let ownerExit: { readonly code: number | null; readonly signal: string | null } | undefined;
  let serverClosed = false;
  const fixture = `<!doctype html><title>FlashAct Aside adapter ${nonce}</title><main id="root">${["scheduled", "reactive", "and", "or", "cancel", "lost", "unarmed"].map(id => `<button type="button" id="${id}" data-ready="no" ${id === "reactive" || id === "or" ? "disabled" : ""}>${id}</button>`).join("")}<span id="signal">idle</span></main><script>document.querySelectorAll('button').forEach(button => button.addEventListener('click', () => { button.dataset.clicks = String(Number(button.dataset.clicks || 0) + 1); const done = document.createElement('span'); done.id = button.id + '-done'; done.textContent = 'Done'; document.querySelector('#root').append(done); navigator.sendBeacon(location.pathname + '/receipt?id=' + button.id + '&epochMs=' + (performance.timeOrigin + performance.now())); }));</script>`;
  const server = createServer((request, response) => {
    const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
    if (incoming.pathname === `/${nonce}`) { response.setHeader("content-type", "text/html"); response.end(fixture); return; }
    if (incoming.pathname === `/${nonce}/receipt`) {
      const parsed = receiptSchema.safeParse(Object.fromEntries(incoming.searchParams));
      if (!parsed.success) { response.writeHead(400).end(); return; }
      receipts.push(parsed.data);
      listeners.get(parsed.data.id)?.(parsed.data);
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });

  async function timed<T>(name: string, action: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try { return await action(); }
    finally { operations.push({ name, ms: performance.now() - start }); }
  }

  function connected(): AsideAdapter {
    if (!adapter) throw new FlashActError("INTERNAL_ERROR", "Aside fixture adapter is unavailable");
    return adapter;
  }

  function plan(id: string, trigger: Trigger): ExecutionPlan {
    return parsePlan({ schemaVersion: "1.0", jobId: `${nonce}-${id}`, name: `Real Aside ${id}`, backend: "aside",
      target: { tabId, selector: `#${id}`, url, watchRoot: "#root" }, trigger, action: { type: "click" }, timezone: "UTC",
      expiresAt: Date.now() + 180_000, maxExecutions: 1, verification: { selector: `#${id}-done`, timeoutMs: 10_000 },
      guards: { approvedUrl: url, allowIrreversible: false } });
  }

  beforeAll(async () => {
    version = (await execAside("aside", ["--version"])).trim();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new FlashActError("INTERNAL_ERROR", "Fixture server address missing");
    url = `http://127.0.0.1:${address.port}/${nonce}`;
    owner = new AsideFixtureOwner();
    const opened = await timed("owner.openTab+snapshot", () => owner ? owner.command(`await openTab(${JSON.stringify(url)}); const view = await snapshot(page, {interactive:true}); console.log(view.tree); return (await listBrowserTabs()).filter(tab => tab.url === ${JSON.stringify(url)}).map(tab => tab.targetId);`) : Promise.reject(new FlashActError("INTERNAL_ERROR", "Owner missing")));
    const ids = z.array(z.string()).length(1).parse(opened);
    tabId = z.string().parse(ids[0]);
    adapter = new AsideAdapter({ tabId });
    await timed("connect", () => connected().connect());
    const tabs = await timed("listTabs", () => connected().listTabs());
    expect(tabs.filter(tab => tab.id === tabId)).toEqual([{ id: tabId, url, title: `FlashAct Aside adapter ${nonce}` }]);
    await timed("selectTab", () => connected().selectTab(tabId));
    expect(await timed("inspectTarget", () => connected().inspectTarget("#scheduled"))).toMatchObject({ count: 1, enabled: true, visible: true, url });
  }, 120_000);

  afterAll(async () => {
    try {
      await timed("disconnect", async () => { await adapter?.disconnect(); });
    } finally {
      try {
        if (tabId) { await transport.repl(`await attachBrowserTab(${JSON.stringify(tabId)}); await closeTab(page);`); closedTab = true; }
      } finally {
        try { ownerExit = await owner?.stop(); }
        finally {
          if (server.listening) {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          }
          serverClosed = true;
          await mkdir("artifacts/qa", { recursive: true });
          await writeFile("artifacts/qa/aside-adapter.json", JSON.stringify({ real: true, recordedAt: new Date().toISOString(), version,
            fixture: { nonce, url, tabId }, commands: ["aside --version", "aside guide", "aside guide repl", "aside repl (interactive owner)", "aside repl <marker-wrapped command>"],
            urlOwnership: "unsupported; existing tabId required", operations, scenarios, receipts,
            cleanup: { closedOnlyOwnedTab: closedTab, ownerExit, serverClosed }, userTabsMutated: false }, null, 2) + "\n");
        }
      }
    }
  }, 120_000);

  it.each(["scheduled", "reactive", "and", "or"] as const)("verifies one click when the %s common-plan trigger is satisfied", async (id) => {
    // Given
    const at = Date.now() + 8_000;
    let trigger: Trigger;
    switch (id) {
      case "scheduled": trigger = { type: "SCHEDULED", at }; break;
      case "reactive": trigger = { type: "ELEMENT_ENABLE", selector: "#reactive" }; break;
      case "and": trigger = { type: "AND", conditions: [{ type: "SCHEDULED", at }, { type: "ATTRIBUTE_CHANGE", selector: "#and", attribute: "data-ready", value: "yes" }] }; break;
      case "or": trigger = { type: "OR", conditions: [{ type: "ELEMENT_APPEAR", selector: "#or-later" }, { type: "TEXT_CHANGE", selector: "#signal", value: "go" }] }; break;
      default: return assertNever(id);
    }
    const input = plan(id, trigger);
    if (id === "or") await connected().evaluate("document.querySelector('#or').disabled = false");
    const handle = await timed(`${id}.installRuntime`, () => connected().installRuntime(input));
    expect(handle.jobId).toBe(input.jobId);
    const clicked = new Promise<Receipt>((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(id); reject(new FlashActError("INTERNAL_ERROR", "Local click receipt timed out")); }, 30_000);
      listeners.set(id, receipt => { clearTimeout(timer); listeners.delete(id); resolve(receipt); });
    });
    // When
    await timed(`${id}.arm`, () => connected().arm(input));
    let changedAt: number | undefined;
    if (id !== "scheduled") {
      const mutation = id === "reactive" ? "document.querySelector('#reactive').disabled = false" : id === "and" ? "document.querySelector('#and').dataset.ready = 'yes'" : "document.querySelector('#signal').textContent = 'go'";
      changedAt = z.number().parse(await timed(`${id}.evaluate-trigger`, () => connected().evaluate(`(() => { ${mutation}; return performance.timeOrigin + performance.now(); })()`)));
    }
    const receipt = await clicked;
    const status = await timed(`${id}.getStatus`, () => connected().getStatus(input.jobId));
    const latencyMs = receipt.epochMs - (id === "scheduled" || id === "and" ? Math.max(at, changedAt ?? at) : changedAt ?? receipt.epochMs);
    scenarios.push({ name: id, plan: input, status, receipt, latencyMs });
    // Then
    expect(status).toMatchObject({ jobId: input.jobId, state: "VERIFIED", executions: 1 });
    expect(receipts.filter(item => item.id === id)).toHaveLength(1);
    expect(await connected().evaluate(`document.querySelector(${JSON.stringify(`#${id}`)}).dataset.clicks`)).toBe("1");
  }, 120_000);

  it("cancels scheduled work before dispatch", async () => {
    // Given
    const input = plan("cancel", { type: "SCHEDULED", at: Date.now() + 60_000 });
    await connected().installRuntime(input);
    await connected().arm(input);
    // When
    await timed("cancel.cancel", () => connected().cancel(input.jobId));
    const status = await timed("cancel.getStatus", () => connected().getStatus(input.jobId));
    scenarios.push({ name: "cancel", plan: input, status });
    // Then
    expect(status).toMatchObject({ state: "CANCELLED", executions: 0 });
  }, 120_000);

  it("retains UNKNOWN for an armed lost document and INVALIDATED for an unarmed document", async () => {
    // Given
    const armed = plan("lost", { type: "SCHEDULED", at: Date.now() + 60_000 });
    const unarmed = plan("unarmed", { type: "SCHEDULED", at: Date.now() + 60_000 });
    await connected().installRuntime(armed);
    await connected().installRuntime(unarmed);
    await connected().arm(armed);
    // When
    await transport.repl(`await attachBrowserTab(${JSON.stringify(tabId)}); await page.reload(); const view = await snapshot(page, {interactive:true}); console.log(view.tree);`);
    const uncertain = await timed("lost.getStatus", () => connected().getStatus(armed.jobId));
    const invalidated = await timed("unarmed.getStatus", () => connected().getStatus(unarmed.jobId));
    scenarios.push({ name: "lost-armed", plan: armed, status: uncertain }, { name: "lost-unarmed", plan: unarmed, status: invalidated });
    // Then
    expect(uncertain.state).toBe("UNKNOWN");
    expect(invalidated.state).toBe("INVALIDATED");
    await expect(connected().arm(armed)).rejects.toMatchObject({ code: "INVALID_STATE" });
  }, 120_000);
});
