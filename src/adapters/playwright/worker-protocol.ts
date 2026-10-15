import { z } from "zod";
import { jobStatusSchema, planSchema } from "../../core/schema.js";
import type { JobStatus } from "../../core/types.js";
import { captureRegionSchema } from "../../captcha/schema.js";

export const deadlines = { startup: 30_000, operation: 5_000, grace: 2_000 } as const;

const identity = { generation: z.string().uuid(), id: z.number().int().positive() };
export const requestSchema = z.discriminatedUnion("method", [
  z.strictObject({ ...identity, method: z.enum(["connect", "listTabs", "disconnect"]) }),
  z.strictObject({ ...identity, method: z.enum(["installRuntime", "arm"]), plan: planSchema }),
  z.strictObject({ ...identity, method: z.enum(["selectTab", "inspectTarget", "wake", "cancel", "getStatus", "evaluate"]), argument: z.string() }),
  z.strictObject({ ...identity, method: z.literal("evaluateCaptcha"), jobId: z.string(), tabId: z.string(), argument: z.string() }),
  z.strictObject({ ...identity, method: z.literal("capture"), tabId: z.string(), region: captureRegionSchema }),
]);
export type WorkerRequest = z.infer<typeof requestSchema>;
export type WorkerMethod = WorkerRequest["method"];

export const initializationSchema = z.strictObject({
  generation: z.string().uuid(),
  endpoint: z.string().min(1),
  artifactsDir: z.string().min(1),
  tabId: z.string().optional(),
  url: z.string().optional(),
});

export const errorCodeSchema = z.enum([
  "INVALID_PLAN", "ADAPTER_ERROR", "INVALID_RESPONSE", "GUARD_REJECTED",
  "JOB_NOT_FOUND", "INVALID_STATE", "INTERNAL_ERROR",
]);
export const eventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("reply"), ...identity, result: z.unknown().optional() }),
  z.strictObject({ kind: z.literal("error"), ...identity, code: errorCodeSchema }),
  z.strictObject({ kind: z.literal("status"), generation: identity.generation, status: jobStatusSchema }),
  z.strictObject({ kind: z.literal("lost"), generation: identity.generation }),
]);
export type WorkerEvent = z.infer<typeof eventSchema>;

/** Browser prose and host execution policy are not trusted transport fields. */
export function transportStatus(status: JobStatus): JobStatus {
  const { message: _message, execution: _execution, ...evidence } = status;
  return evidence;
}
