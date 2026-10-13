import { setTimeout } from 'node:timers/promises';
import type { JobEngine } from '../core/engine.js';
import type { ExecutionPlan, JobStatus } from '../core/types.js';
import { startControlServer } from './ipc.js';

export function printStatus(status: JobStatus): void {
  const { jobId, state, executions, timing, updatedAt, execution } = status;
  process.stdout.write(`${JSON.stringify({ jobId, state, executions, timing, updatedAt, execution })}\n`);
}

/** Signals seal the engine immediately, including during connection acquisition. */
export function engineLifecycle(engine: JobEngine) {
  const controller = new AbortController();
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= engine.close();
    // Observe rejection immediately; callers still await the original cleanup result.
    void closing.catch(() => undefined);
    return closing;
  };
  const stop = () => { controller.abort(); void close(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return { signal: controller.signal, stop, close,
    dispose: () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); } };
}

export async function finalStatuses(engine: JobEngine): Promise<readonly JobStatus[]> {
  return Promise.all(engine.jobIds().map(id => engine.getStatus(id)));
}

export async function runEngineLifetime(engine: JobEngine, action: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const lifecycle = engineLifecycle(engine);
  try {
    try { await action(lifecycle.signal); }
    catch (error) { if (!lifecycle.signal.aborted) throw error; }
  } finally {
    try {
      try { await lifecycle.close(); }
      catch (error) {
        const logs = engine.logs();
        for (const status of logs.filter((status, index) => !logs.slice(index + 1).some(later => later.jobId === status.jobId)))
          printStatus(status);
        throw error;
      }
      for (const status of await finalStatuses(engine)) printStatus(status);
    } finally { lifecycle.dispose(); }
  }
}

export async function foreground(engine: JobEngine, plan: ExecutionPlan, signal: AbortSignal): Promise<void> {
  let control: Awaited<ReturnType<typeof startControlServer>> | undefined;
  const stopAdmission = () => control?.stopAdmission();
  signal.addEventListener('abort', stopAdmission, { once: true });
  try {
    if (signal.aborted) return;
    control = await startControlServer(engine);
    if (signal.aborted) return;
    printStatus(await engine.createJob(plan));
    printStatus(await engine.validateJob(plan.jobId));
    if (signal.aborted) return;
    printStatus(await engine.armJob(plan.jobId));
    let previous = '';
    while (!signal.aborted) {
      const status = await engine.getStatus(plan.jobId);
      const evidence = JSON.stringify({ state: status.state, executions: status.executions,
        execution: status.execution, timing: status.timing });
      if (evidence !== previous) { printStatus(status); previous = evidence; }
      try { await setTimeout(100, undefined, { signal }); }
      catch (error) { if (!(error instanceof Error && error.name === 'AbortError')) throw error; }
    }
  } finally {
    try { await engine.close(); }
    finally { try { await control?.close(); } finally { signal.removeEventListener('abort', stopAdmission); } }
  }
}
