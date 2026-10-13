import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FlashActError, parsePlan, planSchema } from "../src/index.js";
import type { ExecutionPlan } from "../src/index.js";

const plan = {
  schemaVersion: "1.0",
  jobId: "job-1",
  name: "Click when ready",
  backend: "playwright",
  target: { tabId: "tab-1", selector: "#go", url: "https://example.com/task" },
  trigger: { type: "SCHEDULED", at: 1_800_000_000_000 },
  action: { type: "click" },
  timezone: "UTC",
  expiresAt: 1_800_000_060_000,
  maxExecutions: 1,
  verification: { timeoutMs: 1_000 },
  guards: { approvedUrl: "https://example.com/task", allowIrreversible: false },
} as const satisfies ExecutionPlan;

describe("execution plan boundary", () => {
  it.each(["playwright", "aside"] as const)("preserves a valid %s plan", (backend) => {
    // Given
    const input = { ...plan, backend };
    // When
    const result = parsePlan(input);
    // Then
    expect(result).toEqual(input);
  });

  it("preserves optional selectors when supplied", () => {
    // Given
    const input = {
      ...plan,
      target: { ...plan.target, watchRoot: "main" },
      verification: { selector: "#success", timeoutMs: 200 },
    };
    // When
    const result = parsePlan(input);
    // Then
    expect(result).toEqual(input);
  });

  it("accepts historical plans without consulting the clock", () => {
    // Given
    const input = { ...plan, trigger: { type: "SCHEDULED", at: 0 }, expiresAt: 1 };
    // When
    const result = parsePlan(input);
    // Then
    expect(result.expiresAt).toBe(1);
  });

  it.each([
    { schemaVersion: "2.0" },
    { jobId: " " },
    { name: "" },
    { backend: "chrome" },
    { maxExecutions: 0 },
    { maxExecutions: 2 },
    { maxExecutions: "1" },
    { action: { type: "submit" } },
    { timezone: "Invalid/Zone" },
    { expiresAt: -1 },
    { expiresAt: 1.5 },
    { expiresAt: Number.POSITIVE_INFINITY },
    { expiresAt: 8_640_000_000_000_001 },
    { verification: { timeoutMs: 0 } },
    { verification: { timeoutMs: 0.5 } },
    { verification: { timeoutMs: Number.MAX_SAFE_INTEGER + 1 } },
    { verification: { timeoutMs: 1, selector: undefined } },
    { target: { ...plan.target, selector: " " } },
    { target: { ...plan.target, watchRoot: "" } },
    { target: { ...plan.target, watchRoot: undefined } },
    { target: { ...plan.target, url: "/relative" } },
    { guards: { ...plan.guards, approvedUrl: "https://other.example/" } },
    { guards: { approvedUrl: plan.target.url } },
    { guards: { ...plan.guards, allowIrreversible: "false" } },
    { trigger: { type: "ELEMENT_ENABLE", selector: "#go", typo: true } },
    { action: { type: "click", force: true } },
    { verification: { timeoutMs: 100, unexpected: true } },
    { unexpected: true },
  ])("rejects invalid fields %j", (patch) => {
    // Given
    const input = { ...plan, ...patch };
    // When
    const result = planSchema.safeParse(input);
    // Then
    expect(result.success).toBe(false);
  });

  it.each([null, undefined, [], "{}", {}])("rejects malformed plan %j", (input) => {
    // Given: untrusted boundary input.
    // When
    const result = planSchema.safeParse(input);
    // Then
    expect(result.success).toBe(false);
  });

  it("reports typed validation failure with its Zod cause", () => {
    // Given
    const input = { ...plan, maxExecutions: 2 };
    // When
    const parse = () => parsePlan(input);
    // Then
    expect(parse).toThrowError(expect.objectContaining({
      constructor: FlashActError,
      code: "INVALID_PLAN",
      cause: expect.any(z.ZodError),
    }));
  });
});
