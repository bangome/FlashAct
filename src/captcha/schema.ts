import { z } from "zod";
import type { CaptchaPlan, CaptchaStatus } from "./types.js";

const selector = z.string().min(1).max(1024).regex(/\S/);
export const captchaPlanSchema = z.strictObject({
  screenSelector: selector,
  imageSelector: selector,
  inputSelector: selector,
  submitSelector: selector.exactOptional(),
  successSelector: selector.exactOptional(),
  alphabet: z.enum(["uppercase-alphanumeric", "alphanumeric", "digits"]).default("uppercase-alphanumeric"),
  length: z.number().int().min(1).max(32).default(6),
  minConfidence: z.number().min(0).max(1).default(0.8),
  timeoutMs: z.number().int().min(100).max(120000).default(15000),
}).refine(plan => !plan.submitSelector || Boolean(plan.successSelector),
  { message: "Captcha submission requires an explicit success selector", path: ["successSelector"] })
  .readonly() satisfies z.ZodType<CaptchaPlan>;

export const captureRegionSchema = z.strictObject({
  x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(),
  width: z.number().finite().positive().max(2048), height: z.number().finite().positive().max(2048),
}).readonly();

export const captchaStatusSchema = z.strictObject({
  state: z.enum(["PREPARING", "WAITING", "CAPTURING", "RECOGNIZING", "FILLED", "SUBMITTED",
    "VERIFIED", "FAILED", "UNKNOWN", "CANCELLED"]),
  inputs: z.number().int().min(0).max(1), submissions: z.number().int().min(0).max(1),
  confidence: z.number().min(0).max(1).exactOptional(),
  error: z.enum(["LOW_CONFIDENCE", "INVALID_TEXT", "CHALLENGE_CHANGED", "GUARD_REJECTED",
    "TIMEOUT", "CONNECTION_LOST", "OCR_UNAVAILABLE"]).exactOptional(),
  timing: z.strictObject({
    captureMs: z.number().nonnegative().exactOptional(),
    recognitionMs: z.number().nonnegative().exactOptional(),
    inputMs: z.number().nonnegative().exactOptional(),
    totalMs: z.number().nonnegative().exactOptional(),
  }).readonly().exactOptional(),
}).readonly() satisfies z.ZodType<CaptchaStatus>;
