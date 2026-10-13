import { z } from "zod";
import type { AdapterOwner, AsideAdapterOptions, BrowserAdapter } from "../browser-adapter.js";
import type { ExecutionPlan, JobStatus } from "../../core/types.js";
import { browserTabsSchema } from "../../core/schema.js";
import { FlashActError } from "../../utils/errors.js";
import { RuntimeJobs } from "../playwright/runtime-jobs.js";
import { AsideTransport, ManagedAsideRunner } from "./runner.js";
import type { AsideCommandRunner } from "./runner.js";
import { deadlines, transportStatus } from "../playwright/worker-protocol.js";

export type { AsideAdapterOptions } from "../browser-adapter.js";
export type { AsideCommandRunner } from "./runner.js";

const asideTabsSchema = z.array(z.object({ targetId: z.string().min(1), url: z.url(), title: z.string() }));

export class AsideAdapter implements BrowserAdapter {
  private connected = false;
  private selected: string | undefined;
  private readonly transport: AsideTransport;
  protected readonly jobs: RuntimeJobs;

  constructor(private readonly options: AsideAdapterOptions = {}, runner?: AsideCommandRunner, observation?: (status: JobStatus) => void) {
    this.transport = new AsideTransport(options, runner);
    this.jobs = new RuntimeJobs((tabId, expression) => this.evaluateTab(tabId, expression), false, observation);
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
      await this.connectionFailed();
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
    await this.cleanupConnection();
  }

  protected connectionFailed(): Promise<void> { return this.disconnect(); }

  private async cleanupConnection(): Promise<void> {
    try { await this.jobs.disconnect(); }
    finally {
      this.releaseConnection();
    }
  }

  protected releaseConnection(): void { this.selected = undefined; this.connected = false; }

  protected requireConnection(): void {
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

export class OwnedAsideAdapter extends AsideAdapter {
  readonly owner: AdapterOwner;
  private sealed = false;
  private stopping: Promise<readonly JobStatus[]> | undefined;
  private disconnecting: Promise<void> | undefined;
  private readonly managed: ManagedAsideRunner;
  private readonly operations = new Set<Promise<unknown>>();

  constructor(options: AsideAdapterOptions = {}) {
    if (options.endpoint !== undefined || options.launch || options.headless !== undefined
      || options.userDataDir !== undefined || options.url !== undefined || "page" in options || "context" in options) {
      throw new FlashActError("ADAPTER_ERROR", "Owned Aside requires an existing tab through the official CLI");
    }
    let lost: () => void = () => {};
    const managed = new ManagedAsideRunner(() => lost());
    const listeners = new Set<(status: JobStatus) => void>();
    super(options, managed.run, status => { for (const listener of listeners) listener(transportStatus(status)); });
    this.managed = managed;
    this.owner = {
      kind: "aside-client",
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      stop: () => {
        if (this.stopping) return this.stopping;
        this.sealed = true;
        this.stopping = this.managed.stop().then(async () => {
          await Promise.allSettled([...this.operations]);
          this.jobs.invalidate(undefined, "disconnect");
          this.releaseConnection();
          return this.jobs.snapshot().map(transportStatus);
        });
        return this.stopping;
      },
    };
    lost = () => { void this.owner.stop("deadline"); };
  }

  private admission(): void {
    if (this.sealed) throw new FlashActError("ADAPTER_ERROR", "Owned Aside adapter terminated; no reconnect or retry");
  }
  protected override requireConnection(): void { this.admission(); super.requireConnection(); }
  protected override connectionFailed(): Promise<void> { return super.disconnect(); }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.sealed) return Promise.reject(new FlashActError("ADAPTER_ERROR", "Owned Aside adapter terminated; no reconnect or retry"));
    const started = operation().catch((error: unknown) => {
      throw new FlashActError(error instanceof FlashActError ? error.code : "ADAPTER_ERROR", "Owned Aside operation failed");
    });
    this.operations.add(started);
    void started.then(() => this.operations.delete(started), () => this.operations.delete(started));
    return started;
  }
  override connect(): Promise<void> {
    const operation = this.track(() => super.connect());
    return operation.catch((error: unknown) => {
      void this.owner.stop("deadline");
      throw error;
    });
  }
  override listTabs() { return this.track(() => super.listTabs()); }
  override selectTab(tabId: string): Promise<void> { return this.track(() => super.selectTab(tabId)); }
  override inspectTarget(selector: string) { return this.track(() => super.inspectTarget(selector)); }
  override installRuntime(plan: ExecutionPlan) { return this.track(() => super.installRuntime(plan)); }
  override arm(plan: ExecutionPlan): Promise<void> { return this.track(() => super.arm(plan)); }
  override evaluate(expression: string): Promise<unknown> { return this.track(() => super.evaluate(expression)); }
  override getStatus(jobId: string): Promise<JobStatus> { return this.track(() => super.getStatus(jobId)).then(transportStatus); }
  override cancel(jobId: string): Promise<void> {
    return this.track(async () => {
      const timer = setTimeout(() => { void this.owner.stop("cancel"); }, deadlines.grace);
      try { await super.cancel(jobId); }
      finally { clearTimeout(timer); }
    });
  }
  override disconnect(): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    if (this.sealed) return this.owner.stop("shutdown").then(() => {});
    const timer = setTimeout(() => { void this.owner.stop("shutdown"); }, deadlines.grace);
    const cleaning = super.disconnect();
    this.operations.add(cleaning);
    void cleaning.then(() => this.operations.delete(cleaning), () => this.operations.delete(cleaning));
    this.disconnecting = (async () => {
      try { await cleaning; }
      finally {
        try { await this.owner.stop("shutdown"); }
        finally { clearTimeout(timer); }
      }
    })();
    return this.disconnecting;
  }
}
