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
  let unsubscribe: (() => void) | undefined;
  const stopAdmission = () => control?.stopAdmission();
  signal.addEventListener('abort', stopAdmission, { once: true });
  try {
    if (signal.aborted) return;
    control = await startControlServer(engine);
    if (signal.aborted) return;
    let previous = '';
    const report = (status: JobStatus) => {
      if (status.jobId !== plan.jobId) return;
      const evidence = JSON.stringify({ state: status.state, executions: status.executions,
        execution: status.execution, timing: status.timing });
      if (evidence !== previous) { printStatus(status); previous = evidence; }
    };
    unsubscribe = engine.subscribe(report);
    await engine.createJob(plan);
    await engine.validateJob(plan.jobId);
    if (signal.aborted) return;
    await engine.armJob(plan.jobId);
    // Reconcile once for cooperative/held producers; owned observations report independently.
    report(await engine.getStatus(plan.jobId));
    if (!signal.aborted) await new Promise<void>(resolve => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  } finally {
    unsubscribe?.();
    try { await engine.close(); }
    finally { try { await control?.close(); } finally { signal.removeEventListener('abort', stopAdmission); } }
  }
}
