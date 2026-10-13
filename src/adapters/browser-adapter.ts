import type {
  BrowserTab,
  ExecutionPlan,
  JobStatus,
  RuntimeHandle,
  TargetInfo,
} from "../core/types.js";

export interface BrowserAdapter {
  connect(): Promise<void>;
  listTabs(): Promise<readonly BrowserTab[]>;
  selectTab(tabId: string): Promise<void>;
  inspectTarget(selector: string): Promise<TargetInfo>;
  installRuntime(plan: ExecutionPlan): Promise<RuntimeHandle>;
  arm(plan: ExecutionPlan): Promise<void>;
  /** Opt-in readiness check; caller owns scheduling and outstanding transport. */
  wake?(jobId: string): Promise<JobStatus>;
  cancel(jobId: string): Promise<void>;
  getStatus(jobId: string): Promise<JobStatus>;
  evaluate(expression: string): Promise<unknown>;
  disconnect(): Promise<void>;
}

export type AdapterOptions = {
  readonly endpoint?: string;
  readonly launch?: boolean;
  readonly headless?: boolean;
  readonly url?: string;
  readonly userDataDir?: string;
  readonly tabId?: string;
};

export type AsideOptions = {
  readonly executable?: string;
  readonly account?: string;
  readonly host?: string;
};

export type AsideAdapterOptions = AdapterOptions & AsideOptions;
