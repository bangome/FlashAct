import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { JobEngine } from '../core/engine.js';
import { FlashActError } from '../utils/errors.js';
import { benchmark } from '../cli/benchmark.js';

async function response(action: () => Promise<unknown>) {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] };
  } catch (error) {
    const code = error instanceof FlashActError ? error.code : 'INTERNAL_ERROR';
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: code }) }] };
  }
}

export function createMcpServer(engine = new JobEngine()): McpServer {
  const server = new McpServer({ name: 'flashact', version: '0.1.0' });
  const backend = z.enum(['playwright', 'aside']);
  const jobId = z.string().min(1);
  server.registerTool('flashact_list_backends', { inputSchema: {} }, async () => response(async () => ({
    backends: ['playwright', 'aside'], singleShot: true, foreground: true, asideRequiresExistingTab: true,
  })));
  server.registerTool('flashact_list_tabs', { inputSchema: { backend } }, async args => response(() => engine.listTabs(args.backend)));
  server.registerTool('flashact_inspect_target', { inputSchema: { backend, tabId: z.string().min(1), selector: z.string().min(1) } },
    async args => response(() => engine.inspectTarget(args.backend, args.tabId, args.selector)));
  server.registerTool('flashact_create_job', { inputSchema: { plan: z.unknown() } }, async args => response(() => engine.createJob(args.plan)));
  server.registerTool('flashact_validate_job', { inputSchema: { jobId } }, async args => response(() => engine.validateJob(args.jobId)));
  server.registerTool('flashact_arm_job', { inputSchema: { jobId } }, async args => response(() => engine.armJob(args.jobId)));
  server.registerTool('flashact_get_status', { inputSchema: { jobId } }, async args => response(() => engine.getStatus(args.jobId)));
  server.registerTool('flashact_cancel_job', { inputSchema: { jobId } }, async args => response(() => engine.cancelJob(args.jobId)));
  server.registerTool('flashact_get_result', { inputSchema: { jobId } }, async args => response(() => engine.getResult(args.jobId)));
  server.registerTool('flashact_run_benchmark', { inputSchema: { options: z.unknown().optional() } }, async args => response(() => benchmark(args.options ?? {})));
  return server;
}
