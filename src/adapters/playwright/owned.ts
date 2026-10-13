import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { AdapterOptions, AdapterOwner, AdapterStopReason, BrowserAdapter } from "../browser-adapter.js";
import type { BrowserTab, ExecutionPlan, JobStatus, RuntimeHandle, TargetInfo } from "../../core/types.js";
import { browserTabsSchema, jobStatusSchema, runtimeHandleSchema, targetInfoSchema } from "../../core/schema.js";
import { FlashActError, assertNever } from "../../utils/errors.js";
import { ChromeOwner } from "./chrome-owner.js";
import { dispatchable, pending, retainStatus } from "./runtime-jobs.js";
import { deadlines, eventSchema, requestSchema, transportStatus } from "./worker-protocol.js";
import type { WorkerMethod, WorkerRequest } from "./worker-protocol.js";

type PendingRequest = {
  readonly request: WorkerRequest;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};
type RetainedJob = { readonly status: JobStatus; readonly armed: boolean };
export type OwnedDependencies = {
  readonly worker?: (url: URL, initialization: unknown) => Worker;
  readonly chrome?: (profile: string, headless: boolean) => ChromeOwner;
};

/** Only this proxy owns the SDK worker; Chrome is separately owned in its parent. */
export class OwnedPlaywrightAdapter implements BrowserAdapter {
  readonly owner: AdapterOwner;
  private readonly generation = randomUUID();
  private readonly listeners = new Set<(status: JobStatus) => void>();
  private readonly jobs = new Map<string, RetainedJob>();
  private readonly requests = new Map<number, PendingRequest>();
  private nextId = 0;
  private sealed = false;
  private closing = false;
  private root: string | undefined;
  private chrome: ChromeOwner | undefined;
  private worker: Worker | undefined;
  private workerExit: Promise<void> | undefined;
  private connecting: Promise<void> | undefined;
  private stopping: Promise<readonly JobStatus[]> | undefined;
  private disconnecting: Promise<void> | undefined;

  constructor(private readonly options: AdapterOptions = {}, private readonly dependencies: OwnedDependencies = {}) {
    // Check nonserializable extra properties before even allocating a temporary root.
    if ("page" in options || "context" in options || options.userDataDir !== undefined
      || (options.launch === true && options.endpoint !== undefined)
      || (options.launch !== true && !options.endpoint)
      || (options.endpoint !== undefined && options.url !== undefined)) {
      throw new FlashActError("ADAPTER_ERROR", "Owned Playwright requires exclusive launch or endpoint and serializable owned options");
    }
    if (options.launch === true && process.platform !== "darwin" && process.platform !== "linux") {
      throw new FlashActError("ADAPTER_ERROR", "Owned browser process groups require Darwin or Linux");
    }
    this.owner = {
      kind: options.launch === true ? "launched-browser" : "endpoint-client",
      subscribe: listener => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
      },
      stop: reason => this.stop(reason),
    };
  }

  connect(): Promise<void> {
    if (this.sealed || this.closing) return Promise.reject(this.terminated());
    this.connecting ??= this.acquire();
    return this.connecting;
  }

  async listTabs(): Promise<readonly BrowserTab[]> { return browserTabsSchema.parse(await this.rpc({ method: "listTabs" })); }
  async selectTab(tabId: string): Promise<void> { await this.rpc({ method: "selectTab", argument: tabId }); }
  async inspectTarget(selector: string): Promise<TargetInfo> {
    return targetInfoSchema.parse(await this.rpc({ method: "inspectTarget", argument: selector }));
  }
  async installRuntime(plan: ExecutionPlan): Promise<RuntimeHandle> {
    this.ensureOpen();
    if (!this.jobs.has(plan.jobId)) this.jobs.set(plan.jobId, {
      status: { jobId: plan.jobId, state: "VALIDATED", executions: 0, updatedAt: Date.now() }, armed: false,
    });
    const handle = runtimeHandleSchema.parse(await this.rpc({ method: "installRuntime", plan }));
    if (handle.jobId !== plan.jobId) throw new FlashActError("INVALID_RESPONSE", "Worker returned a different job handle");
    return handle;
  }
  async arm(plan: ExecutionPlan): Promise<void> {
    this.ensureOpen();
    const job = this.jobs.get(plan.jobId);
    if (job) this.jobs.set(plan.jobId, { ...job, armed: true });
    await this.rpc({ method: "arm", plan });
  }
  async wake(jobId: string): Promise<JobStatus> { return this.statusReply(jobId, await this.rpc({ method: "wake", argument: jobId })); }
  async cancel(jobId: string): Promise<void> { await this.rpc({ method: "cancel", argument: jobId }); }
  async getStatus(jobId: string): Promise<JobStatus> { return this.statusReply(jobId, await this.rpc({ method: "getStatus", argument: jobId })); }
  evaluate(expression: string): Promise<unknown> { return this.rpc({ method: "evaluate", argument: expression }); }

  disconnect(): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    if (this.sealed) return this.stop("shutdown").then(() => {});
    this.closing = true;
    const timer = setTimeout(() => { void this.stop("shutdown"); }, deadlines.grace);
    this.disconnecting = (async () => {
      try {
        if (this.worker) await this.rpc({ method: "disconnect" }, true);
      } catch (error) {
        if (!this.sealed || !(error instanceof FlashActError)) throw error;
      } finally {
        try { await this.stop("shutdown"); }
        finally { clearTimeout(timer); }
      }
    })();
    return this.disconnecting;
  }

  private terminated(): FlashActError { return new FlashActError("ADAPTER_ERROR", "Owned adapter terminated; no reconnect or retry"); }
  private ensureOpen(internal = false): void {
    if (this.sealed || (this.closing && !internal)) throw this.terminated();
  }

  private async acquire(): Promise<void> {
    const timer = setTimeout(() => { void this.stop("deadline"); }, deadlines.startup);
    try {
      this.root = await mkdtemp(join(tmpdir(), "flashact-owned-"));
      this.ensureOpen();
      const artifactsDir = join(this.root, "artifacts");
      await mkdir(artifactsDir);
      this.ensureOpen();
      let endpoint = this.options.endpoint;
      if (this.options.launch === true) {
        const profile = join(this.root, "profile");
        await mkdir(profile);
        this.ensureOpen();
        this.chrome = this.dependencies.chrome?.(profile, this.options.headless ?? false)
          ?? new ChromeOwner(profile, this.options.headless ?? false);
        void this.chrome.exited.then(() => { void this.stop("deadline"); });
        endpoint = await this.chrome.endpoint;
      }
      this.ensureOpen();
      if (!endpoint) throw new FlashActError("ADAPTER_ERROR", "Owned endpoint unavailable");
      const initialization = {
        generation: this.generation, endpoint, artifactsDir,
        ...(this.options.tabId === undefined ? {} : { tabId: this.options.tabId }),
        ...(this.options.url === undefined ? {} : { url: this.options.url }),
      };
      const url = new URL("./worker.js", import.meta.url);
      const worker = this.dependencies.worker?.(url, initialization)
        ?? new Worker(url, { workerData: initialization, stdout: true, stderr: true });
      this.worker = worker;
      worker.stdout?.resume();
      worker.stderr?.resume();
      this.workerExit = new Promise(resolve => worker.once("exit", () => {
        this.worker = undefined;
        for (const request of this.requests.values()) {
          clearTimeout(request.timer);
          request.reject(this.terminated());
        }
        this.requests.clear();
        resolve();
        if (!this.sealed) void this.stop("deadline");
      }));
      worker.on("message", (value: unknown) => this.receive(value));
      worker.on("error", () => { void this.stop("deadline"); });
      await this.rpc({ method: "connect" });
    } catch (error) {
      // Do not await stop here: stop joins this acquisition continuation.
      void this.stop("deadline");
      if (error instanceof FlashActError) throw error;
      throw new FlashActError("ADAPTER_ERROR", "Owned adapter acquisition failed");
    } finally { clearTimeout(timer); }
  }

  private rpc(input: { readonly method: WorkerMethod; readonly argument?: string; readonly plan?: ExecutionPlan }, internal = false): Promise<unknown> {
    try { this.ensureOpen(internal); }
    catch (error) { return Promise.reject(error); }
    const worker = this.worker;
    if (!worker) return Promise.reject(new FlashActError("ADAPTER_ERROR", "Owned adapter is not connected"));
    const request = requestSchema.parse({ ...input, generation: this.generation, id: ++this.nextId });
    const duration = request.method === "connect" ? deadlines.startup
      : request.method === "cancel" || request.method === "disconnect" ? deadlines.grace : deadlines.operation;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.stop("deadline"); }, duration);
      this.requests.set(request.id, { request, resolve, reject, timer });
      try { worker.postMessage(request); }
      catch (error) {
        // A failed send also joins the actual worker before releasing requests.
        if (error instanceof Error) void this.stop("deadline");
        else throw error;
      }
    });
  }

  private receive(value: unknown): void {
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success) { void this.stop("deadline"); return; }
    const event = parsed.data;
    if (event.generation !== this.generation) return;
    switch (event.kind) {
      case "status": this.retain(transportStatus(event.status)); return;
      case "lost": void this.stop("deadline"); return;
      case "reply": case "error": {
        const pendingRequest = this.requests.get(event.id);
        if (!pendingRequest) return;
        if (event.kind === "reply"
          && (pendingRequest.request.method === "getStatus" || pendingRequest.request.method === "wake")) {
          const status = jobStatusSchema.safeParse(event.result);
          if (!status.success || status.data.jobId !== pendingRequest.request.argument) {
            void this.stop("deadline"); return;
          }
          this.retain(transportStatus(status.data));
        }
        if (this.sealed) return;
        clearTimeout(pendingRequest.timer);
        this.requests.delete(event.id);
        if (event.kind === "error") pendingRequest.reject(new FlashActError(event.code, `Owned worker ${pendingRequest.request.method} failed`));
        else pendingRequest.resolve(event.result);
        return;
      }
      default: assertNever(event);
    }
  }

  private statusReply(jobId: string, value: unknown): JobStatus {
    const status = jobStatusSchema.parse(value);
    if (status.jobId !== jobId) throw new FlashActError("INVALID_RESPONSE", "Worker returned a different job status");
    this.retain(transportStatus(status));
    return this.jobs.get(jobId)?.status ?? transportStatus(status);
  }

  private retain(observation: JobStatus): void {
    const job = this.jobs.get(observation.jobId);
    if (!job) return;
    const status = retainStatus(job.status, observation);
    if (status === job.status) return;
    this.jobs.set(status.jobId, { status, armed: job.armed || dispatchable(status) });
    for (const listener of this.listeners) listener(status);
  }

  private stop(_reason: AdapterStopReason): Promise<readonly JobStatus[]> {
    if (this.stopping) return this.stopping;
    this.sealed = true;
    this.stopping = this.join();
    for (const [jobId, job] of this.jobs) {
      if (!pending(job.status)) continue;
      const status: JobStatus = { ...job.status, state: job.armed || job.status.executions > 0 ? "UNKNOWN" : "FAILED",
        updatedAt: Date.now(), message: "Owned transport stopped; executions is the last observed count, not proof of no effect" };
      this.jobs.set(jobId, { ...job, status });
      for (const listener of this.listeners) listener(status);
    }
    return this.stopping;
  }

  private async join(): Promise<readonly JobStatus[]> {
    const worker = this.worker;
    const chrome = this.chrome;
    const joined = await Promise.allSettled([
      worker ? worker.terminate().then(() => this.workerExit) : this.workerExit,
      chrome?.stop(),
      this.connecting,
    ]);
    // Acquisition may have been inside mkdtemp/mkdir when stop sealed admission.
    if (this.root) await rm(this.root, { recursive: true, force: true });
    const failures = joined.slice(0, 2).filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Owned producer cleanup failed");
    return [...this.jobs.values()].map(job => job.status);
  }
}
