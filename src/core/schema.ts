import { z } from "zod";
import { FlashActError } from "../utils/errors.js";
import { JOB_STATES } from "./types.js";
import { captchaPlanSchema, captchaStatusSchema } from "../captcha/schema.js";
import type {
  BrowserTab,
  ExecutionPlan,
  ExecutionInfo,
  JobStatus,
  RuntimeHandle,
  TargetInfo,
  Trigger,
} from "./types.js";

export const MAX_TRIGGER_DEPTH = 8;
export const MAX_TRIGGER_CONDITIONS = 32;

const text = z.string().regex(/\S/, "Must contain non-whitespace text");
const epochMs = z.number().finite().min(0).max(8_640_000_000_000_000);
const integerEpochMs = epochMs.int();
const count = z.number().int().nonnegative();
const url = z.url();

const leafTriggerSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("SCHEDULED"), at: integerEpochMs }),
  z.strictObject({
    type: z.enum(["ELEMENT_APPEAR", "ELEMENT_ENABLE", "ELEMENT_VISIBLE"]),
    selector: text,
  }),
  z.strictObject({
    type: z.literal("ATTRIBUTE_CHANGE"),
    selector: text,
    attribute: text,
    value: z.string().exactOptional(),
  }),
  z.strictObject({
    type: z.literal("TEXT_CHANGE"),
    selector: text,
    value: z.string().exactOptional(),
  }),
]).readonly();

// Bound the parser itself, so even cyclic input cannot cause unbounded recursion.
function boundedTriggerSchema(depth: number): z.ZodType<Trigger> {
  if (depth === 1) return leafTriggerSchema;
  return z.union([
    leafTriggerSchema,
    z.strictObject({
      type: z.enum(["AND", "OR"]),
      conditions: z.array(boundedTriggerSchema(depth - 1))
        .min(1).max(MAX_TRIGGER_CONDITIONS).readonly(),
    }).readonly(),
  ]);
}

export const triggerSchema = boundedTriggerSchema(MAX_TRIGGER_DEPTH);

const timezone = text.refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}, "Must be a supported timezone");

export const planSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  jobId: text,
  name: text,
  backend: z.enum(["playwright", "aside"]),
  target: z.strictObject({
    tabId: text,
    selector: text,
    url,
    watchRoot: text.exactOptional(),
  }).readonly(),
  trigger: triggerSchema,
  action: z.strictObject({ type: z.enum(["click", "captcha"]) }).readonly(),
  timezone,
  expiresAt: integerEpochMs,
  maxExecutions: z.literal(1),
  captcha: captchaPlanSchema.exactOptional(),
  verification: z.strictObject({
    selector: text.exactOptional(),
    timeoutMs: z.number().int().positive(),
  }).readonly(),
  guards: z.strictObject({
    approvedUrl: url,
    allowIrreversible: z.boolean(),
  }).readonly(),
}).refine((plan) => plan.target.url === plan.guards.approvedUrl, {
  path: ["guards", "approvedUrl"],
  message: "Approved URL must exactly match the target URL",
}).refine(plan => plan.action.type === "click" || Boolean(plan.captcha),
  { message: "Captcha-only actions require captcha configuration", path: ["captcha"] })
  .refine(plan => plan.action.type === "click" || plan.target.selector === plan.captcha?.imageSelector,
    { message: "Captcha-only target must be the configured image selector", path: ["target", "selector"] })
  .refine(plan => !plan.captcha || !plan.verification.selector || plan.verification.timeoutMs >= plan.captcha.timeoutMs,
  { message: "Click verification must allow the configured captcha timeout", path: ["verification", "timeoutMs"] })
  .refine(plan => !plan.captcha?.submitSelector || plan.captcha.submitSelector !== plan.target.selector,
    { message: "Captcha must not submit through the original click selector", path: ["captcha", "submitSelector"] })
  .readonly() satisfies z.ZodType<ExecutionPlan>;

export const executionInfoSchema = z.strictObject({
  requested: z.enum(["browser", "auto", "host"]),
  scheduler: z.enum(["browser", "host-assisted"]),
  transport: z.enum(["direct", "owned-worker", "owned-aside-cli"]),
  browserOwnership: z.enum(["owned", "borrowed"]),
  reason: z.enum([
    "explicit-browser", "explicit-host", "scheduled-leaves",
    "no-scheduled-leaves", "unsupported-host-wake", "cooperative-transport",
  ]),
}).readonly() satisfies z.ZodType<ExecutionInfo>;

export const jobStatusSchema = z.strictObject({
  jobId: text,
  state: z.enum(JOB_STATES),
  executions: count.max(1),
  message: z.string().exactOptional(),
  execution: executionInfoSchema.exactOptional(),
  captcha: captchaStatusSchema.exactOptional(),
  timing: z.strictObject({
    targetEpochMs: epochMs.exactOptional(),
    schedulerEpochMs: epochMs.exactOptional(),
    receivedEpochMs: epochMs.exactOptional(),
    observerEpochMs: epochMs.exactOptional(),
    clickEpochMs: epochMs.exactOptional(),
    conditionEpochMs: epochMs.exactOptional(),
  }).readonly().exactOptional(),
  updatedAt: integerEpochMs,
}).readonly() satisfies z.ZodType<JobStatus>;

export const targetInfoSchema = z.strictObject({
  selector: text,
  count,
  enabled: z.boolean(),
  visible: z.boolean(),
  url,
  irreversible: z.boolean(),
}).readonly() satisfies z.ZodType<TargetInfo>;

export const browserTabsSchema = z.array(z.strictObject({
  id: text,
  url,
  title: z.string(),
}).readonly()).readonly() satisfies z.ZodType<readonly BrowserTab[]>;

export const runtimeHandleSchema = z.strictObject({
  jobId: text,
  documentId: text,
}).readonly() satisfies z.ZodType<RuntimeHandle>;

export function parsePlan(input: unknown): ExecutionPlan {
  const result = planSchema.safeParse(input);
  if (!result.success) {
    throw new FlashActError("INVALID_PLAN", "Execution plan validation failed", {
      cause: result.error,
    });
  }
  return result.data;
}
