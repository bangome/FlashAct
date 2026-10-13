import { randomUUID } from "node:crypto";
import { z } from "zod";
import { jobStatusSchema, runtimeHandleSchema, targetInfoSchema, parsePlan } from "../../core/schema.js";
import type { ExecutionPlan, JobStatus, RuntimeHandle, TargetInfo } from "../../core/types.js";
import { inspectExpression, installExpression, runtimeSource, statusExpression } from "../../runtime/index.js";
import { FlashActError, assertNever } from "../../utils/errors.js";

export function decodeRuntime<T>(value: unknown, schema: z.ZodType<T>): T {
  try {
    const decoded: unknown = JSON.parse(z.string().parse(value));
    return schema.parse(decoded);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new FlashActError("INVALID_RESPONSE", "Invalid browser runtime response", { cause: error });
    }
    throw error;
  }
}

type TrackedJob = {
  readonly tabId: string;
  readonly handle: RuntimeHandle;
  readonly token: string;
  readonly status: JobStatus;
  readonly lost: boolean;
  readonly armed: boolean;
  readonly lossReason?: "document" | "close" | "disconnect";
};

const commandResponseSchema = z.discriminatedUnion("current", [
  z.object({ current: z.literal(false) }),
  z.object({ current: z.literal(true), status: jobStatusSchema }),
]);

const stateRank = {
  DRAFT: 0, VALIDATED: 1, ARMED: 2, WAITING: 3, DISPATCHED: 4,
  VERIFIED: 5, UNKNOWN: 5, FAILED: 5, EXPIRED: 5, CANCELLED: 5, INVALIDATED: 5,
} as const;

export function pending(status: JobStatus): boolean {
  switch (status.state) {
    case "DRAFT": case "VALIDATED": case "ARMED": case "WAITING": case "DISPATCHED": return true;
    case "VERIFIED": case "UNKNOWN": case "FAILED": case "EXPIRED": case "CANCELLED": case "INVALIDATED": return false;
    default: return assertNever(status.state);
  }
}

export function dispatchable(status: JobStatus): boolean {
  switch (status.state) {
    case "ARMED": case "WAITING": case "DISPATCHED": return true;
    case "DRAFT": case "VALIDATED": case "VERIFIED": case "UNKNOWN":
    case "FAILED": case "EXPIRED": case "CANCELLED": case "INVALIDATED": return false;
    default: return assertNever(status.state);
  }
}

export function retainStatus(previous: JobStatus, observation: JobStatus, lost = false): JobStatus {
  const status = observation.state === "INVALIDATED" && observation.executions > 0
    ? { ...observation, state: "UNKNOWN" as const } : observation;
  if (lost || !pending(previous)) {
    if (status.executions > previous.executions) {
      const timing = status.timing ?? previous.timing;
      return { ...previous, state: "UNKNOWN", executions: status.executions,
        ...(timing ? { timing } : {}),
        message: "Execution observed after terminal or lost status; no retry" };
    }
    return previous;
  }
  if (status.executions >= previous.executions && stateRank[status.state] >= stateRank[previous.state]) {
    const timing = status.timing ?? previous.timing;
    return timing ? { ...status, timing } : status;
  }
  return previous;
}

export class RuntimeJobs {
  readonly eventMarker = `__FLASHACT_STATUS_${randomUUID()}__`;
  private readonly jobs = new Map<string, TrackedJob>();
  private readonly marker = `__flashact_adapter_${randomUUID().replaceAll("-", "")}`;

  constructor(private readonly evaluateTab: (tabId: string, expression: string) => Promise<unknown>,
    private readonly observesDispatch = true, private readonly observation?: (status: JobStatus) => void) {}

  snapshot(): readonly JobStatus[] { return [...this.jobs.values()].map(job => job.status); }

  async inspect(tabId: string, selector: string): Promise<TargetInfo> {
    return decodeRuntime(await this.evaluateTab(tabId, inspectExpression(selector)), targetInfoSchema);
  }

  async install(input: ExecutionPlan): Promise<RuntimeHandle> {
    const plan = parsePlan(input);
    if (this.jobs.has(plan.jobId)) throw new FlashActError("INVALID_STATE", "Job already installed");
    await this.evaluateTab(plan.target.tabId, runtimeSource());
    const handle = decodeRuntime(await this.evaluateTab(plan.target.tabId, installExpression(plan)), runtimeHandleSchema);
    if (handle.jobId !== plan.jobId) throw new FlashActError("INVALID_RESPONSE", "Runtime returned a different job");
    const token = randomUUID();
    await this.evaluateTab(plan.target.tabId, `(() => { const runtime = globalThis.__flashactRuntime; const report = () => console.log(${JSON.stringify(this.eventMarker)} + JSON.stringify(runtime.status(${JSON.stringify(plan.jobId)}))); globalThis[${JSON.stringify(this.marker + plan.jobId)}] = { token: ${JSON.stringify(token)}, runtime, cleanup: () => { window.removeEventListener("click", report, true); window.removeEventListener("pagehide", report); } }; window.addEventListener("click", report, true); window.addEventListener("pagehide", report); })()`);
    const status = decodeRuntime(await this.evaluateTab(plan.target.tabId, statusExpression(plan.jobId)), jobStatusSchema);
    this.jobs.set(plan.jobId, { tabId: plan.target.tabId, handle, token, status, lost: false, armed: dispatchable(status) });
    this.observation?.(status);
    return handle;
  }

  async arm(input: ExecutionPlan): Promise<void> {
    const plan = parsePlan(input);
    const job = this.requireJob(plan.jobId);
    if (job.tabId !== plan.target.tabId) throw new FlashActError("INVALID_STATE", "Installed tab does not match plan");
    await this.command(plan.jobId, "arm");
  }

  async wake(jobId: string): Promise<JobStatus> { return this.command(jobId, "wake"); }

  async cancel(jobId: string): Promise<void> {
    const job = this.requireJob(jobId);
    if (!job.lost && pending(job.status)) await this.command(jobId, "cancel");
  }

  async status(jobId: string): Promise<JobStatus> {
    const job = this.requireJob(jobId);
    if (job.lost || !pending(job.status)) return job.status;
    try {
      return await this.command(jobId, "status");
    } catch (error) {
      if (error instanceof Error) {
        if (error instanceof FlashActError && error.code === "INVALID_RESPONSE") throw error;
        this.invalidate(job.tabId, "document");
        return this.requireJob(jobId).status;
      }
      throw error;
    }
  }

  invalidate(tabId: string | undefined, reason: "document" | "close" | "disconnect"): void {
    for (const [id, job] of this.jobs) {
      if (reason === "disconnect" && job.lossReason === "close" && job.status.executions === 0 && !job.armed) {
        this.jobs.set(id, { ...job, lossReason: reason, status: { ...job.status, state: "FAILED", updatedAt: Date.now(), message: "Runtime lost: disconnect" } });
        this.observation?.(this.requireJob(id).status);
        continue;
      }
      if ((tabId === undefined || tabId === job.tabId) && !job.lost && pending(job.status)) {
        // Transport teardown can emit page close first; neither event proves an armed remote timer stopped.
        const uncertain = job.armed && (!this.observesDispatch || reason !== "document");
        const dispatched = job.status.executions > 0 || job.status.state === "DISPATCHED" || uncertain;
        const state = dispatched ? "UNKNOWN" : reason === "disconnect" ? "FAILED" : "INVALIDATED";
        const message = uncertain ? `Runtime lost: ${reason}; dispatch may have occurred after the last observation; executions is the last observed count, not proof of no click` : `Runtime lost: ${reason}`;
        this.jobs.set(id, { ...job, lost: true, lossReason: reason, status: { ...job.status, state, updatedAt: Date.now(), message } });
        this.observation?.(this.requireJob(id).status);
      }
    }
  }

  receive(text: string): void {
    if (!text.startsWith(this.eventMarker)) return;
    let decoded: unknown;
    try { decoded = JSON.parse(text.slice(this.eventMarker.length)); }
    catch (error) { if (error instanceof SyntaxError) return; throw error; }
    const parsed = jobStatusSchema.safeParse(decoded);
    if (!parsed.success) return;
    if (this.jobs.has(parsed.data.jobId)) this.retain(parsed.data.jobId, parsed.data);
  }

  async disconnect(): Promise<void> {
    const results = await Promise.allSettled([...this.jobs.keys()].map((id) => this.cancel(id)));
    this.invalidate(undefined, "disconnect");
    for (const result of results) {
      switch (result.status) {
        case "fulfilled": break;
        // Transport loss is retained as FAILED/UNKNOWN; teardown must still proceed.
        case "rejected": if (!(result.reason instanceof Error)) throw result.reason; break;
        default: assertNever(result);
      }
    }
  }

  private requireJob(jobId: string): TrackedJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new FlashActError("JOB_NOT_FOUND", `Job not installed: ${jobId}`);
    return job;
  }

  private retain(jobId: string, observation: JobStatus): JobStatus {
    const job = this.requireJob(jobId);
    const status = retainStatus(job.status, observation, job.lost);
    if (status !== job.status) {
      this.jobs.set(jobId, { ...job, status, armed: job.armed || dispatchable(status) });
      this.observation?.(status);
    }
    return this.requireJob(jobId).status;
  }

  private async command(jobId: string, method: "arm" | "cancel" | "status" | "wake"): Promise<JobStatus> {
    const job = this.requireJob(jobId);
    if (job.lost) throw new FlashActError("INVALID_STATE", "Installed document is no longer available");
    const attempted = method === "arm" ? { ...job, armed: true } : job;
    if (method === "arm") this.jobs.set(jobId, attempted);
    // Binding and command run in one browser task on the captured runtime, not
    // in two RPCs with a replacement-document gap.
    const response = decodeRuntime(await this.evaluateTab(job.tabId, `(() => {
      const installed = globalThis[${JSON.stringify(this.marker + jobId)}];
      if (!(installed?.token === ${JSON.stringify(job.token)}
        && installed.runtime === globalThis.__flashactRuntime
        && installed.runtime?.documentId === ${JSON.stringify(job.handle.documentId)}))
        return JSON.stringify({ current: false });
      return JSON.stringify({ current: true, status: installed.runtime[${JSON.stringify(method)}](${JSON.stringify(jobId)}) });
    })()`), commandResponseSchema);
    if (!response.current) {
      // A rejected atomic binding proves this attempt never armed. Restore its
      // prior flag only if no concurrent observation/arm replaced our record.
      if (method === "arm" && this.requireJob(jobId) === attempted) this.jobs.set(jobId, job);
      this.invalidate(job.tabId, "document");
      throw new FlashActError("INVALID_STATE", "Installed document was replaced");
    }
    const status = response.status;
    if (status.jobId !== jobId) throw new FlashActError("INVALID_RESPONSE", "Runtime returned a different job status");
    const retained = this.retain(jobId, status);
    if (!pending(retained) && !this.requireJob(jobId).lost) await this.evaluateTab(job.tabId,
      `(() => { const installed = globalThis[${JSON.stringify(this.marker + jobId)}];
        if (installed?.token === ${JSON.stringify(job.token)} && installed.runtime === globalThis.__flashactRuntime
          && installed.runtime?.documentId === ${JSON.stringify(job.handle.documentId)}) installed.cleanup(); })()`);
    return this.requireJob(jobId).status;
  }
}
