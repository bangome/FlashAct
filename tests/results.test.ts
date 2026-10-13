import { describe, expect, it } from "vitest";
import {
  browserTabsSchema,
  jobStatusSchema,
  runtimeHandleSchema,
  targetInfoSchema,
} from "../src/index.js";

const status = { jobId: "job-1", state: "WAITING", executions: 0, updatedAt: 100 };
const target = {
  selector: "#go", count: 1, enabled: true, visible: true,
  url: "https://example.com/task", irreversible: false,
};

describe("job status boundary", () => {
  const execution = {
    requested: "auto", scheduler: "host-assisted", transport: "owned-worker",
    browserOwnership: "borrowed", reason: "scheduled-leaves",
  };

  it("preserves declared execution source metadata", () => {
    // Given
    const input = { ...status, execution };
    // When
    const result = jobStatusSchema.parse(input);
    // Then
    expect(result).toEqual(input);
  });

  it.each([
    null, undefined, { ...execution, requested: "unsafe" },
    { ...execution, scheduler: "poll" }, { ...execution, transport: "abandoned-promise" },
    { ...execution, browserOwnership: "unknown" }, { ...execution, reason: "fallback" },
    { ...execution, endpoint: "http://127.0.0.1:1234" },
  ])("rejects malformed execution metadata %j", execution => {
    // Given
    const input = { ...status, execution };
    // When
    const result = jobStatusSchema.safeParse(input);
    // Then
    expect(result.success).toBe(false);
  });

  it.each([
    "DRAFT", "VALIDATED", "ARMED", "WAITING", "DISPATCHED", "VERIFIED",
    "UNKNOWN", "FAILED", "EXPIRED", "CANCELLED", "INVALIDATED",
  ])("accepts the %s state", (state) => {
    // Given
    const input = { ...status, state };
    // When
    const result = jobStatusSchema.parse(input);
    // Then
    expect(result).toEqual(input);
  });

  it("preserves all timing measurements including fractional epochs", () => {
    // Given
    const input = {
      ...status, state: "VERIFIED", executions: 1, message: "",
      timing: {
        targetEpochMs: 100, schedulerEpochMs: 101.25, receivedEpochMs: 102.5,
        observerEpochMs: 103.25, clickEpochMs: 104.5, conditionEpochMs: 103.75,
      },
    };
    // When
    const result = jobStatusSchema.parse(input);
    // Then
    expect(result).toEqual(input);
  });

  it.each([
    { state: "SUCCESS" }, { state: "waiting" },
    { executions: -1 }, { executions: 2 }, { executions: 0.5 }, { executions: "1" },
    { updatedAt: -1 }, { updatedAt: 0.5 }, { updatedAt: Number.POSITIVE_INFINITY },
    { jobId: "" }, { message: null }, { message: undefined }, { timing: undefined },
    { timing: { clickEpochMs: Number.NaN } }, { timing: { clickEpochMs: -1 } },
    { timing: { targetEpochMs: undefined } }, { timing: { extraEpochMs: 1 } },
    { unexpected: true },
  ])("rejects invalid status fields %j", (patch) => {
    // Given
    const input = { ...status, ...patch };
    // When
    const result = jobStatusSchema.safeParse(input);
    // Then
    expect(result.success).toBe(false);
  });
});

describe("browser result boundaries", () => {
  it("preserves inspected target data", () => {
    // Given
    const input = target;
    // When
    const result = targetInfoSchema.parse(input);
    // Then
    expect(result).toEqual(input);
  });

  it.each([
    { count: -1 }, { count: 0.5 }, { count: Number.MAX_SAFE_INTEGER + 1 },
    { enabled: "true" }, { visible: null }, { irreversible: undefined },
    { url: "relative" }, { unexpected: true },
  ])("rejects invalid target fields %j", (patch) => {
    // Given
    const input = { ...target, ...patch };
    // When
    const result = targetInfoSchema.safeParse(input);
    // Then
    expect(result.success).toBe(false);
  });

  it.each([
    { input: [] },
    { input: [{ id: "tab-1", url: "about:blank", title: "" }] },
  ])(
    "accepts browser tab list $input", ({ input }) => {
      // Given
      // When
      const result = browserTabsSchema.parse(input);
      // Then
      expect(result).toEqual(input);
    },
  );

  it.each([
    [{ id: 1, url: "about:blank", title: "" }],
    [{ id: "tab-1", url: "about:blank" }],
    [{ id: "tab-1", url: "relative", title: "" }],
    [{ id: "tab-1", url: "about:blank", title: "", extra: true }],
    { tabs: [] },
  ].map((input) => ({ input })))("rejects malformed browser tab list $input", ({ input }) => {
    // Given
    // When
    const result = browserTabsSchema.safeParse(input);
    // Then
    expect(result.success).toBe(false);
  });

  it("preserves job and document identity in runtime handles", () => {
    // Given
    const input = { jobId: "job-1", documentId: "document-2" };
    // When
    const result = runtimeHandleSchema.parse(input);
    // Then
    expect(result).toEqual(input);
  });

  it.each([
    { jobId: "job-1" }, { jobId: "job-1", documentId: "" },
    { jobId: "", documentId: "document-2" },
    { jobId: "job-1", documentId: 2 },
    { jobId: "job-1", documentId: "document-2", extra: true },
  ])("rejects malformed runtime handle %j", (input) => {
    // Given
    // When
    const result = runtimeHandleSchema.safeParse(input);
    // Then
    expect(result.success).toBe(false);
  });
});
