import type { ExecutionPlan } from "../core/types.js";
import { bootstrap } from "./bootstrap.js";
import { createDom } from "./dom.js";
import { createJob } from "./job.js";
import { createTriggers } from "./triggers.js";

/** A self-contained expression: every factory is serialized, with no module closure references. */
export function runtimeSource(): string {
  return `(${bootstrap.toString()})(${createDom.toString()},${createTriggers.toString()},${createJob.toString()})`;
}

export function installExpression(plan: ExecutionPlan): string {
  return `JSON.stringify((${runtimeSource()}).install(${JSON.stringify(plan)}))`;
}

export function armExpression(jobId: string): string {
  return `JSON.stringify(globalThis.__flashactRuntime.arm(${JSON.stringify(jobId)}))`;
}

export function wakeExpression(jobId: string): string {
  return `JSON.stringify(globalThis.__flashactRuntime.wake(${JSON.stringify(jobId)}))`;
}

export function cancelExpression(jobId: string): string {
  return `JSON.stringify(globalThis.__flashactRuntime.cancel(${JSON.stringify(jobId)}))`;
}

export function statusExpression(jobId: string): string {
  return `JSON.stringify(globalThis.__flashactRuntime.status(${JSON.stringify(jobId)}))`;
}

export function inspectExpression(selector: string): string {
  return `JSON.stringify((${runtimeSource()}).inspect(${JSON.stringify(selector)}))`;
}
