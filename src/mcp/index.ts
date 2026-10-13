import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { JobEngine } from '../core/engine.js';
import type { EngineOptions } from '../core/engine.js';
import { startControlServer } from '../cli/ipc.js';
import { createMcpServer } from './server.js';
import { engineLifecycle, finalStatuses } from '../cli/foreground.js';
import { FlashActError } from '../utils/errors.js';

export { createMcpServer } from './server.js';

export async function serveStdio(options: EngineOptions = {}): Promise<void> {
  const engine = new JobEngine({ adapterMode: 'owned', scheduling: 'auto', ...options });
  const server = createMcpServer(engine);
  let control: Awaited<ReturnType<typeof startControlServer>> | undefined;
  let resolveStop: () => void = () => undefined;
  const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
  const lifecycle = engineLifecycle(engine);
  const stopAdmission = () => control?.stopAdmission();
  const stop = () => { lifecycle.stop(); resolveStop(); };
  lifecycle.signal.addEventListener('abort', resolveStop, { once: true });
  lifecycle.signal.addEventListener('abort', stopAdmission, { once: true });
  process.stdin.once('end', stop);
  server.server.onclose = stop;
  try {
    control = await startControlServer(engine);
    if (!lifecycle.signal.aborted) {
      await server.connect(new StdioServerTransport());
      await stopped;
    }
  } finally {
    let cleanupError: unknown;
    try { await lifecycle.close(); } catch (error) { cleanupError = error; }
    const statuses = cleanupError === undefined ? await finalStatuses(engine) : engine.logs()
      .filter((status, index, logs) => !logs.slice(index + 1).some(later => later.jobId === status.jobId));
    try { await server.close(); } catch (error) { cleanupError ??= error; }
    try { await control?.close(); } catch (error) { cleanupError ??= error; }
    process.stdin.off('end', stop);
    lifecycle.signal.removeEventListener('abort', resolveStop);
    lifecycle.signal.removeEventListener('abort', stopAdmission);
    lifecycle.dispose();
    process.stderr.write(`${JSON.stringify({ event: 'shutdown', cleanup: cleanupError === undefined,
      finalStatuses: statuses, ...(cleanupError === undefined ? {} :
        { error: cleanupError instanceof FlashActError ? cleanupError.code : 'INTERNAL_ERROR' }) })}\n`);
    if (cleanupError !== undefined) throw cleanupError;
  }
}
