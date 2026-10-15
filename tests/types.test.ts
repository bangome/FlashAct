import { expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  assertNever,
  browserTabsSchema,
  executionInfoSchema,
  jobStatusSchema,
  parsePlan,
  planSchema,
  runtimeHandleSchema,
  targetInfoSchema,
  triggerSchema,
  wakeExpression,
} from "../src/index.js";
import type {
  AdapterOptions,
  AdapterOwner,
  AsideOptions,
  BrowserAdapter,
  BrowserTab,
  ExecutionPlan,
  ExecutionInfo,
  JobStatus,
  RuntimeHandle,
  TargetInfo,
  Trigger,
  CaptureRegion,
} from "../src/index.js";

it("keeps schema output identical to the public domain contracts", () => {
  // Given
  // When
  // Then
  expectTypeOf<z.output<typeof planSchema>>().toEqualTypeOf<ExecutionPlan>();
  expectTypeOf<z.output<typeof triggerSchema>>().toEqualTypeOf<Trigger>();
  expectTypeOf<z.output<typeof jobStatusSchema>>().toEqualTypeOf<JobStatus>();
  expectTypeOf<z.output<typeof executionInfoSchema>>().toEqualTypeOf<ExecutionInfo>();
  expectTypeOf<z.output<typeof targetInfoSchema>>().toEqualTypeOf<TargetInfo>();
  expectTypeOf<z.output<typeof browserTabsSchema>>().toEqualTypeOf<readonly BrowserTab[]>();
  expectTypeOf<z.output<typeof runtimeHandleSchema>>().toEqualTypeOf<RuntimeHandle>();
  expectTypeOf(parsePlan).toEqualTypeOf<(input: unknown) => ExecutionPlan>();
  expectTypeOf(assertNever).toEqualTypeOf<(value: never) => never>();
});

it("keeps asynchronous adapter signatures independent of implementation", () => {
  // Given
  // When
  // Then
  expectTypeOf<BrowserAdapter>().toEqualTypeOf<{
    readonly owner?: AdapterOwner;
    connect(): Promise<void>;
    listTabs(): Promise<readonly BrowserTab[]>;
    selectTab(tabId: string): Promise<void>;
    inspectTarget(selector: string): Promise<TargetInfo>;
    installRuntime(plan: ExecutionPlan): Promise<RuntimeHandle>;
    arm(plan: ExecutionPlan): Promise<void>;
    wake?(jobId: string): Promise<JobStatus>;
    cancel(jobId: string): Promise<void>;
    getStatus(jobId: string): Promise<JobStatus>;
    evaluate(expression: string): Promise<unknown>;
    evaluateCaptcha?(jobId: string, tabId: string, expression: string): Promise<unknown>;
    capture?(tabId: string, region: CaptureRegion): Promise<string>;
    closeCaptcha?(jobId: string): Promise<void>;
    disconnect(): Promise<void>;
  }>();
  expectTypeOf(wakeExpression).toEqualTypeOf<(jobId: string) => string>();
});

it("keeps adapter options optional without accepting explicit undefined", () => {
  // Given
  // When
  // Then
  expectTypeOf<AdapterOptions>().toEqualTypeOf<{
    readonly endpoint?: string;
    readonly launch?: boolean;
    readonly headless?: boolean;
    readonly url?: string;
    readonly userDataDir?: string;
    readonly tabId?: string;
  }>();
  expectTypeOf<AsideOptions>().toEqualTypeOf<{
    readonly executable?: string;
    readonly account?: string;
    readonly host?: string;
  }>();
});
