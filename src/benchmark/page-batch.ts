import type { ExecutionPlan, JobStatus, RuntimeHandle, Trigger } from '../core/types.js';
import type { BenchmarkSample } from './statistics.js';

type Runtime = {
  readonly install: (plan: ExecutionPlan) => RuntimeHandle;
  readonly arm: (jobId: string) => unknown;
  readonly status: (jobId: string) => JobStatus;
  readonly cancel: (jobId: string) => unknown;
};
type Fixture = {
  readonly ledger: readonly {readonly jobId: string; readonly epochMs: number; readonly wallMs: number; readonly trusted: boolean}[];
  readonly reset: (id: string, enabled?: boolean) => number;
  readonly enable: () => number;
  readonly replace: () => void;
};
export type BatchOptions = {
  readonly backend: 'playwright' | 'aside';
  readonly iterations: number;
  readonly scenario: string;
};

/** Serialized into the document; no host imports or IPC in the measured path. */
export async function pageBatch(runtime: Runtime, fixture: Fixture, options: BatchOptions): Promise<string> {
  const samples: BenchmarkSample[] = [];
  const now = (): number => performance.timeOrigin + performance.now();
  const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const terminal = new Set(['VERIFIED', 'UNKNOWN', 'FAILED', 'EXPIRED', 'CANCELLED', 'INVALIDATED']);
  for (let i = 0; i < options.iterations; i++) {
    const id = `bench-${options.scenario}-${Date.now()}-${i}`;
    const wallAnchor = Date.now();
    const pageAnchor = now();
    const scheduled = {type: 'SCHEDULED', at: wallAnchor + 12} as const;
    const scheduledPageTarget = pageAnchor + 12;
    const enabled = {type: 'ELEMENT_ENABLE', selector: '#reserve'} as const;
    let trigger: Trigger;
    switch (options.scenario) {
      case 'scheduled': case 'high-cpu': case 'background': trigger = scheduled; break;
      case 'and-time-first': case 'and-element-first': case 'simultaneous':
        trigger = {type: 'AND', conditions: [scheduled, enabled]}; break;
      case 'or': trigger = {type: 'OR', conditions: [scheduled, enabled]}; break;
      default: trigger = enabled;
    }
    fixture.reset(id, options.scenario === 'scheduled' || options.scenario === 'high-cpu' || options.scenario === 'background');
    const plan: ExecutionPlan = {
      schemaVersion: '1.0', jobId: id, name: id, backend: options.backend,
      target: {tabId: 'owned-fixture', selector: '#reserve', url: location.href},
      trigger, action: {type: 'click'}, timezone: 'UTC', expiresAt: Date.now() + 3000,
      maxExecutions: 1, verification: {timeoutMs: 1000},
      guards: {approvedUrl: location.href, allowIrreversible: false},
    };
    let target = scheduledPageTarget;
    try {
      runtime.install(plan);
      runtime.arm(id);
      switch (options.scenario) {
        case 'scheduled': case 'background': break;
        case 'high-cpu': {
          const until = performance.now() + 30;
          while (performance.now() < until) { Math.sqrt(performance.now()); }
          break;
        }
        case 'and-time-first':
          await pause(20); target = fixture.enable(); break;
        case 'and-element-first': fixture.enable(); break;
        case 'simultaneous':
          await pause(Math.max(0, scheduled.at - Date.now())); target = fixture.enable();
          runtime.arm(id); break;
        case 'or': target = fixture.enable(); break;
        case 'replacement': fixture.replace(); target = fixture.enable(); break;
        default: target = fixture.enable();
      }
      const deadline = performance.now() + 3500;
      while (!terminal.has(runtime.status(id).state) && performance.now() < deadline) await pause(1);
      // Allow another observer delivery to expose duplicate dispatch rather than ending at first click.
      await pause(1);
      samples.push({jobId: id, scenario: options.scenario, targetEpochMs: target,
        clicks: fixture.ledger.filter(click => click.jobId === id), status: runtime.status(id),
        ...(target === scheduledPageTarget ? {wallTargetEpochMs: scheduled.at, targetUncertaintyMs: 1} : {})});
    } finally { runtime.cancel(id); }
  }
  return JSON.stringify({samples, visibility: document.visibilityState, measuredAt: now(),
    teardown: {cancelledJobs: samples.length}});
}

export function batchExpression(options: BatchOptions): string {
  return `(${pageBatch.toString()})(globalThis.__flashactRuntime,globalThis.__flashactFixture,${JSON.stringify(options)})`;
}
