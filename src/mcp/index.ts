import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { JobEngine } from '../core/engine.js';
import type { EngineOptions } from '../core/engine.js';
import { startControlServer } from '../cli/ipc.js';
import { createMcpServer } from './server.js';

export { createMcpServer } from './server.js';

export async function serveStdio(options: EngineOptions = {}): Promise<void> {
  const engine = new JobEngine(options);
  const server = createMcpServer(engine);
  let control: Awaited<ReturnType<typeof startControlServer>> | undefined;
  let resolveStop: () => void = () => undefined;
  const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
  const stop = () => resolveStop();
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.stdin.once('end', stop);
  server.server.onclose = stop;
  try {
    control = await startControlServer(engine);
    await server.connect(new StdioServerTransport());
    await stopped;
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop); process.stdin.off('end', stop);
    try { await engine.close(); }
    finally { try { await server.close(); } finally { await control?.close(); } }
  }
}
