export type Backend = "playwright" | "aside";

export type Trigger =
  | { readonly type: "SCHEDULED"; readonly at: number }
  | {
      readonly type: "ELEMENT_APPEAR" | "ELEMENT_ENABLE" | "ELEMENT_VISIBLE";
      readonly selector: string;
    }
  | {
      readonly type: "ATTRIBUTE_CHANGE";
      readonly selector: string;
      readonly attribute: string;
      readonly value?: string;
    }
  | {
      readonly type: "TEXT_CHANGE";
      readonly selector: string;
      readonly value?: string;
    }
  | { readonly type: "AND" | "OR"; readonly conditions: readonly Trigger[] };

export type ExecutionPlan = {
  readonly schemaVersion: "1.0";
  readonly jobId: string;
  readonly name: string;
  readonly backend: Backend;
  readonly target: {
    readonly tabId: string;
    readonly selector: string;
    readonly url: string;
    readonly watchRoot?: string;
  };
  readonly trigger: Trigger;
  readonly action: { readonly type: "click" };
  readonly timezone: string;
  readonly expiresAt: number;
  readonly maxExecutions: 1;
  readonly verification: {
    readonly selector?: string;
    readonly timeoutMs: number;
  };
  readonly guards: {
    readonly approvedUrl: string;
    readonly allowIrreversible: boolean;
  };
};

export const JOB_STATES = [
  "DRAFT",
  "VALIDATED",
  "ARMED",
  "WAITING",
  "DISPATCHED",
  "VERIFIED",
  "UNKNOWN",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
  "INVALIDATED",
] as const;

export type JobState = (typeof JOB_STATES)[number];

export type JobTiming = {
  readonly targetEpochMs?: number;
  readonly schedulerEpochMs?: number;
  readonly receivedEpochMs?: number;
  readonly observerEpochMs?: number;
  readonly clickEpochMs?: number;
  readonly conditionEpochMs?: number;
};

export type JobStatus = {
  readonly jobId: string;
  readonly state: JobState;
  readonly executions: number;
  readonly message?: string;
  readonly timing?: JobTiming;
  readonly updatedAt: number;
};

export type RuntimeHandle = {
  readonly jobId: string;
  readonly documentId: string;
};

export type TargetInfo = {
  readonly selector: string;
  readonly count: number;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly url: string;
  readonly irreversible: boolean;
};

export type BrowserTab = {
  readonly id: string;
  readonly url: string;
  readonly title: string;
};
