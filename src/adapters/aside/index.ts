import { z } from "zod";
import type { AdapterOwner, AsideAdapterOptions, BrowserAdapter } from "../browser-adapter.js";
import type { ExecutionPlan, JobStatus } from "../../core/types.js";
import { browserTabsSchema } from "../../core/schema.js";
import { FlashActError } from "../../utils/errors.js";
import { RuntimeJobs, pending } from "../playwright/runtime-jobs.js";
import { AsideTransport } from "./runner.js";
import type { AsideCommandRunner } from "./runner.js";
import { deadlines, transportStatus } from "../playwright/worker-protocol.js";
import { AsideSession, asideChangeRead } from "./session.js";
import { captureRegionSchema } from "../../captcha/schema.js";
import type { CaptureRegion } from "../../captcha/types.js";
import { cropViewportPng, viewportSchema } from "../../captcha/crop.js";

export type { AsideAdapterOptions } from "../browser-adapter.js";
export type { AsideCommandRunner } from "./runner.js";

const asideTabsSchema = z.array(z.object({ targetId: z.string().min(1), url: z.url(), title: z.string() }));

export class AsideAdapter implements BrowserAdapter {
  private connected = false;
  protected selected: string | undefined;
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
  async evaluateCaptcha(_jobId: string, tabId: string, expression: string): Promise<unknown> {
    return this.evaluateTab(tabId, expression);
  }
  async capture(tabId: string, region: CaptureRegion): Promise<string> {
    this.requireConnection();
    captureRegionSchema.parse(region);
    const result = z.strictObject({ image: z.string(), viewport: viewportSchema }).parse(
      await this.transport.repl(`await attachBrowserTab(${JSON.stringify(tabId)});
      const view=()=>({width:innerWidth,height:innerHeight,scrollX,scrollY});
      const before=await page.evaluate(view);
      const image=Buffer.from(await page.screenshot({type:"png"})).toString("base64");
      const after=await page.evaluate(view);
      if(JSON.stringify(before)!==JSON.stringify(after))throw new Error("Viewport changed during capture");
      return {image,viewport:before};`));
    return cropViewportPng(result.image, region, result.viewport);
  }

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

  protected selectedId(): string {
    this.requireConnection();
    if (!this.selected) throw new FlashActError("ADAPTER_ERROR", "No Aside tab selected");
    return this.selected;
  }

  protected async evaluateTab(tabId: string, expression: string): Promise<unknown> {
    this.requireConnection();
    return this.transport.repl(`await attachBrowserTab(${JSON.stringify(tabId)}); return await page.evaluate(${JSON.stringify(expression)});`);
  }
}

export class OwnedAsideAdapter extends AsideAdapter {
  readonly owner: AdapterOwner;
  private sealed = false;
  private stopping: Promise<readonly JobStatus[]> | undefined;
  private disconnecting: Promise<void> | undefined;
  private readonly managed: AsideSession;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly readers = new Map<string, AsideSession>();
  private readonly captchaReaders = new Map<string, AsideSession>();
  private readonly changes = new Set<Promise<void>>();
  private readonly optionsForReader: AsideAdapterOptions;

  constructor(options: AsideAdapterOptions = {}) {
    if (options.endpoint !== undefined || options.launch || options.headless !== undefined
      || options.userDataDir !== undefined || options.url !== undefined || "page" in options || "context" in options) {
      throw new FlashActError("ADAPTER_ERROR", "Owned Aside requires an existing tab through the official CLI");
    }
    let lost: () => void = () => {};
    const managed = new AsideSession(options, () => lost());
    const listeners = new Set<(status: JobStatus) => void>();
    super(options, managed.run, status => { for (const listener of listeners) listener(transportStatus(status)); });
    this.optionsForReader = { ...options };
    this.managed = managed;
    this.owner = {
      kind: "aside-client",
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      stop: () => {
        if (this.stopping) return this.stopping;
        this.sealed = true;
        this.stopping = Promise.all([this.managed.stop(), ...[...this.readers.values(), ...this.captchaReaders.values()].map(reader => reader.stop())]).then(async () => {
          await Promise.allSettled([...this.operations]);
          await Promise.allSettled([...this.changes]);
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
  override selectTab(tabId: string): Promise<void> {
    return this.track(async () => { if (this.selected !== tabId) await super.selectTab(tabId); });
  }
  override inspectTarget(selector: string) {
    return this.track(() => this.jobs.inspect(this.selectedId(), selector));
  }
  override installRuntime(plan: ExecutionPlan) { return this.track(() => super.installRuntime(plan)); }
  override arm(plan: ExecutionPlan): Promise<void> {
    return this.track(async () => {
      await super.arm(plan);
      if (!this.sealed && this.jobs.snapshot().some(status => status.jobId === plan.jobId && pending(status)))
        this.observeChanges(plan.jobId);
    });
  }
  override evaluate(expression: string): Promise<unknown> { return this.track(() => super.evaluate(expression)); }
  override evaluateCaptcha(jobId: string, tabId: string, expression: string): Promise<unknown> {
    return this.track(() => {
      let reader = this.captchaReaders.get(jobId);
      if (!reader) {
        reader = new AsideSession(this.optionsForReader);
        this.captchaReaders.set(jobId, reader);
      }
      return reader.evaluate(tabId, expression);
    });
  }
  override capture(tabId: string, region: CaptureRegion): Promise<string> {
    return this.track(() => this.managed.capture(tabId, region));
  }
  async closeCaptcha(jobId: string): Promise<void> {
    const reader = this.captchaReaders.get(jobId);
    await reader?.stop();
    this.captchaReaders.delete(jobId);
  }
  override getStatus(jobId: string): Promise<JobStatus> { return this.track(() => super.getStatus(jobId)).then(transportStatus); }
  protected override evaluateTab(tabId: string, expression: string): Promise<unknown> {
    return this.track(() => this.managed.evaluate(tabId, expression));
  }
  private observeChanges(jobId: string): void {
    // Aside serializes REPL calls. A waiting reader must not block cancel/control.
    const reader = new AsideSession(this.optionsForReader, () => { void this.owner.stop("deadline"); });
    this.readers.set(jobId, reader);
    const changed = (async () => {
      try {
        while (!this.sealed) {
          const status = await this.jobs.waitForChange(jobId,
            (tabId, expression) => reader.evaluate(tabId, expression, asideChangeRead.rpcTimeoutMs), asideChangeRead.leaseMs);
          if (!pending(status)) break;
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        void this.owner.stop("deadline");
      } finally {
        await reader.stop();
        this.readers.delete(jobId);
      }
    })();
    this.changes.add(changed);
    void changed.then(() => this.changes.delete(changed), () => this.changes.delete(changed));
  }
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
