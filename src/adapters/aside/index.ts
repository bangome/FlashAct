import { z } from "zod";
import type { AsideAdapterOptions, BrowserAdapter } from "../browser-adapter.js";
import type { ExecutionPlan } from "../../core/types.js";
import { browserTabsSchema } from "../../core/schema.js";
import { FlashActError } from "../../utils/errors.js";
import { RuntimeJobs } from "../playwright/runtime-jobs.js";
import { AsideTransport } from "./runner.js";
import type { AsideCommandRunner } from "./runner.js";

export type { AsideAdapterOptions } from "../browser-adapter.js";
export type { AsideCommandRunner } from "./runner.js";

const asideTabsSchema = z.array(z.object({ targetId: z.string().min(1), url: z.url(), title: z.string() }));

export class AsideAdapter implements BrowserAdapter {
  private connected = false;
  private selected: string | undefined;
  private readonly transport: AsideTransport;
  private readonly jobs = new RuntimeJobs((tabId, expression) => this.evaluateTab(tabId, expression), false);

  constructor(private readonly options: AsideAdapterOptions = {}, runner?: AsideCommandRunner) {
    this.transport = new AsideTransport(options, runner);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.options.url !== undefined) {
      throw new FlashActError("ADAPTER_ERROR", "Aside options.url is unsupported: one-shot openTab tabs disappear when their owning session exits. Keep an existing tab open and supply its exact tabId.");
    }
    if (this.options.endpoint || this.options.launch || this.options.userDataDir) {
      throw new FlashActError("ADAPTER_ERROR", "Aside attaches through its official CLI; endpoint, launch and userDataDir are unsupported");
    }
    await this.transport.version();
    this.connected = true;
    try {
      await this.listTabs();
      if (this.options.tabId !== undefined) await this.selectTab(this.options.tabId);
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async listTabs() {
    this.requireConnection();
    const result = await this.transport.repl("return await listBrowserTabs();");
    const parsed = asideTabsSchema.safeParse(result);
    if (!parsed.success) throw new FlashActError("INVALID_RESPONSE", "Invalid Aside browser tab list", { cause: parsed.error });
    return browserTabsSchema.parse(parsed.data.map((tab) => ({ id: tab.targetId, url: tab.url, title: tab.title })));
  }

  async selectTab(tabId: string): Promise<void> {
    const tabs = await this.listTabs();
    if (!tabs.some((tab) => tab.id === tabId)) throw new FlashActError("ADAPTER_ERROR", `Aside tab not found: ${tabId}`);
    await this.transport.repl(`await attachBrowserTab(${JSON.stringify(tabId)}); const view = await snapshot(page, {interactive:true}); console.log(view.tree);`);
    this.selected = tabId;
  }

  async inspectTarget(selector: string) {
    const tabId = this.selectedId();
    await this.transport.repl(`await attachBrowserTab(${JSON.stringify(tabId)}); const view = await snapshot(page, {selector:${JSON.stringify(selector)}}); console.log(view.tree);`);
    return this.jobs.inspect(tabId, selector);
  }

  async installRuntime(plan: ExecutionPlan) { this.requireConnection(); return this.jobs.install(plan); }
  async arm(plan: ExecutionPlan): Promise<void> { this.requireConnection(); await this.jobs.arm(plan); }
  async cancel(jobId: string): Promise<void> { await this.jobs.cancel(jobId); }
  async getStatus(jobId: string) { return this.jobs.status(jobId); }
  async evaluate(expression: string): Promise<unknown> { return this.evaluateTab(this.selectedId(), expression); }

  async disconnect(): Promise<void> {
    try { await this.jobs.disconnect(); }
    finally {
      this.selected = undefined;
      this.connected = false;
    }
  }

  private requireConnection(): void {
    if (!this.connected) throw new FlashActError("ADAPTER_ERROR", "Aside adapter is disconnected");
  }

  private selectedId(): string {
    this.requireConnection();
    if (!this.selected) throw new FlashActError("ADAPTER_ERROR", "No Aside tab selected");
    return this.selected;
  }

  private async evaluateTab(tabId: string, expression: string): Promise<unknown> {
    this.requireConnection();
    return this.transport.repl(`await attachBrowserTab(${JSON.stringify(tabId)}); return await page.evaluate(${JSON.stringify(expression)});`);
  }
}
