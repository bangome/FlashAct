import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { ExecutionPlan } from "../../src/core/types.js";
import { armExpression, cancelExpression, inspectExpression, installExpression, runtimeSource, statusExpression, wakeExpression } from "../../src/runtime/index.js";

describe("runtime expression transport", () => {
  it.each([armExpression, wakeExpression, cancelExpression, statusExpression])("preserves hostile job IDs when constructing commands", (expression) => {
    // Given
    const jobId = '\"); globalThis.compromised = true; //\n\u2028';
    const runtime = { arm: (id: string) => ({ jobId: id }), wake: (id: string) => ({ jobId: id }), cancel: (id: string) => ({ jobId: id }), status: (id: string) => ({ jobId: id }) };
    const sandbox = { __flashactRuntime: runtime, compromised: false };
    // When
    const result: unknown = runInNewContext(expression(jobId), sandbox);
    // Then
    expect(result).toBe(JSON.stringify({ jobId }));
    expect(sandbox.compromised).toBe(false);
  });

  it("injects without arming when installing a plan", () => {
    // Given
    const plan: ExecutionPlan = { schemaVersion: "1.0", jobId: "quoted-'\"", name: "single", backend: "playwright",
      target: { tabId: "test", selector: "#action", url: "about:blank" }, trigger: { type: "SCHEDULED", at: 10 },
      action: { type: "click" }, timezone: "UTC", expiresAt: 20, maxExecutions: 1,
      verification: { timeoutMs: 10 }, guards: { approvedUrl: "about:blank", allowIrreversible: false } };
    const installed: ExecutionPlan[] = [];
    let armed = false;
    const runtime = { install: (input: ExecutionPlan) => { installed.push(input); return { jobId: input.jobId, documentId: "document" }; }, arm: () => { armed = true; } };
    // When
    const result: unknown = runInNewContext(installExpression(plan), { __flashactRuntime: runtime });
    // Then
    expect(result).toBe(JSON.stringify({ jobId: plan.jobId, documentId: "document" }));
    expect(installed).toEqual([plan]);
    expect(armed).toBe(false);
  });

  it("preserves selector escaping when inspecting", () => {
    // Given
    const selector = '[data-label="a\\\"b"]';
    const runtime = { inspect: (value: string) => ({ selector: value, count: 1 }) };
    // When
    const result: unknown = runInNewContext(inspectExpression(selector), { __flashactRuntime: runtime });
    // Then
    expect(result).toBe(JSON.stringify({ selector, count: 1 }));
  });

  it("retains an existing document runtime when injecting again", () => {
    // Given
    const runtime = { documentId: "stable" };
    // When
    const result: unknown = runInNewContext(runtimeSource(), { __flashactRuntime: runtime });
    // Then
    expect(result).toBe(runtime);
  });
});
