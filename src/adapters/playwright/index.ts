import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page, Frame, ConsoleMessage } from "playwright";
import { z } from "zod";
import type { AdapterOptions, BrowserAdapter } from "../browser-adapter.js";
import type { ExecutionPlan, JobStatus } from "../../core/types.js";
import { browserTabsSchema } from "../../core/schema.js";
import { FlashActError } from "../../utils/errors.js";
import { RuntimeJobs } from "./runtime-jobs.js";

export type PlaywrightAdapterOptions = AdapterOptions & {
  readonly page?: Page;
  readonly context?: BrowserContext;
};

export type PlaywrightConnectionHooks = {
  readonly artifactsDir: string;
  readonly observation: (status: JobStatus) => void;
  readonly lost: () => void;
};

export class PlaywrightAdapter implements BrowserAdapter {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private connected = false;
  private selected: string | undefined;
  private readonly pages = new Map<string, Page>();
  private readonly identities = new WeakMap<Page, string>();
  private readonly listeners = new Map<Page, { readonly close: () => void; readonly navigation: (frame: Frame) => void }>();
  private readonly jobs: RuntimeJobs;
  private readonly disconnected = (): void => { this.connected = false; this.jobs.invalidate(undefined, "disconnect"); this.hooks?.lost(); };
  private readonly consoleMessage = (message: ConsoleMessage): void => { this.jobs.receive(message.text()); };

  constructor(private readonly options: PlaywrightAdapterOptions = {}, private readonly hooks?: PlaywrightConnectionHooks) {
    this.jobs = new RuntimeJobs((tabId, expression) => this.evaluateTab(tabId, expression), true, hooks?.observation);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const options = this.options;
    try {
      if (options.page || options.context) {
        this.context = options.page?.context() ?? options.context;
        this.browser = this.context?.browser() ?? undefined;
      } else if (options.endpoint) {
        this.browser = await chromium.connectOverCDP(options.endpoint, {
          timeout: 30_000, ...(this.hooks ? { noDefaults: true, artifactsDir: this.hooks.artifactsDir } : {}),
        });
      } else if (options.launch === true) {
        if (options.userDataDir) {
          this.context = await chromium.launchPersistentContext(options.userDataDir, { headless: options.headless ?? true, timeout: 30_000 });
          this.browser = this.context.browser() ?? undefined;
        } else {
          this.browser = await chromium.launch({ headless: options.headless ?? true, timeout: 30_000 });
          this.context = await this.browser.newContext();
        }
      } else {
        throw new FlashActError("ADAPTER_ERROR", "Supply a page, context, endpoint, or explicitly set launch: true");
      }
      this.connected = true;
      this.browser?.on("disconnected", this.disconnected);
      if (options.url) {
        const context = this.context ?? this.browser?.contexts()[0];
        if (!context) throw new FlashActError("ADAPTER_ERROR", "No browser context available");
        const page = await context.newPage();
        await page.goto(options.url, { timeout: 30_000 });
        this.selected = await this.register(page);
      }
      if (options.launch === true && !options.page && !options.context && !options.endpoint && this.context?.pages().length === 0) {
        await this.context.newPage();
      }
      const tabs = await this.listTabs();
      const id = options.tabId ?? (options.page ? await this.register(options.page) : this.selected ?? tabs[0]?.id);
      if (id) await this.selectTab(id);
    } catch (error) {
      await this.disconnect();
      if (error instanceof FlashActError) throw error;
      if (error instanceof Error) throw new FlashActError("ADAPTER_ERROR", "Playwright connection failed", { cause: error });
      throw error;
    }
  }

  async listTabs() {
    this.requireConnection();
    const contexts = this.browser?.contexts() ?? (this.context ? [this.context] : []);
    const tabs = [];
    for (const context of contexts) {
      for (const page of context.pages()) {
        if (!page.isClosed()) tabs.push({ id: await this.register(page), url: page.url(), title: await page.title() });
      }
    }
    return browserTabsSchema.parse(tabs);
  }

  async selectTab(tabId: string): Promise<void> {
    await this.listTabs();
    this.pageFor(tabId);
    this.selected = tabId;
  }

  async inspectTarget(selector: string) { return this.jobs.inspect(this.selectedId(), selector); }
  async installRuntime(plan: ExecutionPlan) { this.requireConnection(); return this.jobs.install(plan); }
  async arm(plan: ExecutionPlan): Promise<void> { this.requireConnection(); await this.jobs.arm(plan); }
  async wake(jobId: string) { this.requireConnection(); return this.jobs.wake(jobId); }
  async cancel(jobId: string): Promise<void> { await this.jobs.cancel(jobId); }
  async getStatus(jobId: string) { return this.jobs.status(jobId); }
  async evaluate(expression: string): Promise<unknown> { return this.evaluateTab(this.selectedId(), expression); }

  async disconnect(): Promise<void> {
    await this.jobs.disconnect();
    this.browser?.off("disconnected", this.disconnected);
    for (const [page, handlers] of this.listeners) {
      page.off("close", handlers.close);
      page.off("framenavigated", handlers.navigation);
      page.off("console", this.consoleMessage);
    }
    this.listeners.clear();
    this.connected = false;
    const browser = this.browser;
    const context = this.context;
    this.browser = undefined;
    this.context = undefined;
    this.pages.clear();
    this.selected = undefined;
    // Public close() on connectOverCDP disconnects the client, not the attached browser.
    if (!this.options.page && !this.options.context) {
      if (this.options.endpoint) await browser?.close();
      else if (this.options.launch === true) {
        if (this.options.userDataDir) await context?.close();
        else await browser?.close();
      }
    }
  }

  private requireConnection(): void {
    if (!this.connected) throw new FlashActError("ADAPTER_ERROR", "Playwright adapter is disconnected");
  }

  private selectedId(): string {
    this.requireConnection();
    if (!this.selected) throw new FlashActError("ADAPTER_ERROR", "No tab selected");
    return this.selected;
  }

  private pageFor(tabId: string): Page {
    this.requireConnection();
    const page = this.pages.get(tabId);
    if (!page || page.isClosed()) throw new FlashActError("ADAPTER_ERROR", `Tab not available: ${tabId}`);
    return page;
  }

  private async evaluateTab(tabId: string, expression: string): Promise<unknown> {
    try { return await this.pageFor(tabId).evaluate(expression); }
    catch (error) {
      if (error instanceof FlashActError) throw error;
      if (error instanceof Error) throw new FlashActError("ADAPTER_ERROR", "Browser evaluation failed", { cause: error });
      throw error;
    }
  }

  private async register(page: Page): Promise<string> {
    for (const [id, existing] of this.pages) if (existing === page) return id;
    let id: string = this.identities.get(page) ?? randomUUID();
    if (this.options.endpoint && !this.options.page && !this.options.context) {
      const session = await page.context().newCDPSession(page);
      try {
        const response: unknown = await session.send("Target.getTargetInfo");
        id = z.object({ targetInfo: z.object({ targetId: z.string().min(1) }) }).parse(response).targetInfo.targetId;
      } finally { await session.detach(); }
    }
    this.pages.set(id, page);
    this.identities.set(page, id);
    const close = (): void => { this.jobs.invalidate(id, "close"); this.pages.delete(id); };
    const navigation = (frame: Frame): void => { if (frame === page.mainFrame()) this.jobs.invalidate(id, "document"); };
    page.on("close", close);
    page.on("framenavigated", navigation);
    page.on("console", this.consoleMessage);
    this.listeners.set(page, { close, navigation });
    return id;
  }
}
