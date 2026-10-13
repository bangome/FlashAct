import type { ExecutionPlan, JobStatus, RuntimeHandle, TargetInfo, Trigger } from "../core/types.js";
import type { createDom } from "./dom.js";
import type { createJob } from "./job.js";
import type { createTriggers } from "./triggers.js";

export type BrowserRuntime = {
  readonly documentId: string;
  readonly install: (plan: ExecutionPlan) => RuntimeHandle;
  readonly arm: (jobId: string) => JobStatus;
  readonly wake: (jobId: string) => JobStatus;
  readonly cancel: (jobId: string) => JobStatus;
  readonly status: (jobId: string) => JobStatus;
  readonly inspect: (selector: string) => TargetInfo;
};

declare global {
  // Injection owns this document-local property; navigation creates a new realm.
  var __flashactRuntime: BrowserRuntime | undefined;
}

export function bootstrap(domFactory: typeof createDom, triggerFactory: typeof createTriggers, jobFactory: typeof createJob): BrowserRuntime {
  if (globalThis.__flashactRuntime) return globalThis.__flashactRuntime;
  const dom = domFactory();
  const documentId = `${performance.timeOrigin}-${Math.random().toString(36).slice(2)}`;
  const initialUrl = location.href;
  const jobs = new Map<string, { readonly signature: string; readonly handle: RuntimeHandle; readonly job: ReturnType<typeof createJob> }>();
  let validDocument = true;
  const invalidate = () => {
    validDocument = false;
    for (const entry of jobs.values()) entry.job.invalidate();
  };
  window.addEventListener("pagehide", invalidate);
  window.addEventListener("beforeunload", invalidate);
  window.addEventListener("popstate", () => { if (location.href !== initialUrl) invalidate(); });
  window.addEventListener("hashchange", () => { if (location.href !== initialUrl) invalidate(); });
  const valid = () => {
    if (location.href !== initialUrl) invalidate();
    return validDocument;
  };
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item: unknown) => canonical(item));
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]: [string, unknown]) => [key, canonical(item)]));
    return value;
  }
  function validateTrigger(trigger: Trigger): void {
    switch (trigger.type) {
      case "AND": case "OR": trigger.conditions.forEach(validateTrigger); return;
      case "SCHEDULED": return;
      case "ELEMENT_APPEAR": case "ELEMENT_ENABLE": case "ELEMENT_VISIBLE": case "ATTRIBUTE_CHANGE": case "TEXT_CHANGE": dom.select(trigger.selector); return;
      default: return dom.unreachable(trigger);
    }
  }
  function get(jobId: string) {
    const entry = jobs.get(jobId);
    if (!entry) return dom.fail("JOB_NOT_FOUND", `Unknown runtime job: ${jobId}`);
    return entry.job;
  }
  const runtime: BrowserRuntime = {
    documentId,
    install(input) {
      // Host boundary already parsed ExecutionPlan; clone to prevent post-install caller mutation.
      const plan = structuredClone(input);
      const signature = JSON.stringify(canonical(plan));
      const existing = jobs.get(plan.jobId);
      if (existing) {
        if (existing.signature !== signature) return dom.fail("INVALID_PLAN", "Job ID already belongs to a different plan");
        return { ...existing.handle };
      }
      if (!valid() || location.href !== plan.guards.approvedUrl || plan.target.url !== plan.guards.approvedUrl) return dom.fail("GUARD_REJECTED", "Document URL does not match approved URL");
      dom.select(plan.target.selector);
      if (plan.target.watchRoot) dom.select(plan.target.watchRoot);
      if (plan.verification.selector) dom.select(plan.verification.selector);
      validateTrigger(plan.trigger);
      const handle = { jobId: plan.jobId, documentId };
      jobs.set(plan.jobId, { signature, handle, job: jobFactory(plan, { dom, triggers: triggerFactory, valid }) });
      return { ...handle };
    },
    arm: (jobId) => get(jobId).arm(),
    wake: (jobId) => get(jobId).wake(),
    cancel: (jobId) => get(jobId).cancel(),
    status: (jobId) => get(jobId).status(),
    inspect: dom.inspect,
  };
  globalThis.__flashactRuntime = runtime;
  return runtime;
}
