import { setTimeout } from 'node:timers/promises';
import type { JobEngine } from '../core/engine.js';
import type { ExecutionPlan, JobStatus } from '../core/types.js';
import { startControlServer } from './ipc.js';

export function printStatus(status: JobStatus): void {
  const { jobId, state, executions, timing, updatedAt } = status;
  process.stdout.write(`${JSON.stringify({ jobId, state, executions, timing, updatedAt })}\n`);
}

export async function foreground(engine: JobEngine, plan: ExecutionPlan): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let control: Awaited<ReturnType<typeof startControlServer>> | undefined;
  try {
    control = await startControlServer(engine);
    if (controller.signal.aborted) return;
    printStatus(await engine.createJob(plan));
    printStatus(await engine.validateJob(plan.jobId));
    if (controller.signal.aborted) return;
    printStatus(await engine.armJob(plan.jobId));
    let previous = '';
    while (!controller.signal.aborted) {
      const status = await engine.getStatus(plan.jobId);
      if (status.state !== previous) { printStatus(status); previous = status.state; }
      try { await setTimeout(100, undefined, { signal: controller.signal }); }
      catch (error) { if (!(error instanceof Error && error.name === 'AbortError')) throw error; }
    }
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    try { await engine.close(); }
    finally { await control?.close(); }
  }
}
