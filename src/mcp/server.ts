import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { JobEngine } from '../core/engine.js';
import { FlashActError } from '../utils/errors.js';
import { benchmark } from '../cli/benchmark.js';
import { captchaPlanSchema } from '../captcha/schema.js';

async function response(action: () => Promise<unknown>) {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] };
  } catch (error) {
    const code = error instanceof FlashActError ? error.code : 'INTERNAL_ERROR';
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: code }) }] };
  }
}

export function createMcpServer(engine = new JobEngine({ adapterMode: 'owned', scheduling: 'auto' })): McpServer {
  const server = new McpServer({ name: 'flashact', version: '0.1.0' });
  const backend = z.enum(['playwright', 'aside']);
  const jobId = z.string().min(1);
  server.registerTool('flashact_list_backends', { inputSchema: {} }, async () => response(async () => ({
    backends: ['playwright', 'aside'], singleShot: true, foreground: true, asideRequiresExistingTab: true,
    capabilities: engine.capabilities(), defaultScheduling: engine.defaultScheduling,
    captcha: {
      provider: 'macos-vision', requiresSwift: true, textImageOnly: true,
      prepareBeforeArm: true, maxInputs: 1, maxSubmissions: 1,
      planSchema: { ...z.toJSONSchema(captchaPlanSchema, { io: 'input' }),
        dependentRequired: { submitSelector: ['successSelector'] } },
    },
  })));
  server.registerTool('flashact_list_tabs', { inputSchema: { backend } }, async args => response(() => engine.listTabs(args.backend)));
  server.registerTool('flashact_inspect_target', { inputSchema: { backend, tabId: z.string().min(1), selector: z.string().min(1) } },
    async args => response(() => engine.inspectTarget(args.backend, args.tabId, args.selector)));
  server.registerTool('flashact_create_job', {
    description: 'Create, not arm, an ExecutionPlan. Optional plan.captcha supports text-image CAPTCHA only: required imageSelector/inputSelector; optional submitSelector requires successSelector. Defaults: alphabet uppercase-alphanumeric (also alphanumeric/digits), length 6 (1..32), minConfidence 0.8 (0..1), timeoutMs 15000 (100..120000). See flashact_list_backends captcha.planSchema. A primary verification.selector requires verification.timeoutMs >= captcha.timeoutMs. Local macOS Vision/Swift prepares before arm; no keys/downloads. One input and explicit optional submission, no retry/reconnect/rearm. Read nested status.captcha separately: main VERIFIED is not CAPTCHA success. No CAPTCHA text/images in output.',
    inputSchema: { plan: z.unknown() },
  }, async args => response(() => engine.createJob(args.plan)));
  server.registerTool('flashact_validate_job', { inputSchema: { jobId } }, async args => response(() => engine.validateJob(args.jobId)));
  server.registerTool('flashact_arm_job', { inputSchema: { jobId } }, async args => response(() => engine.armJob(args.jobId)));
  server.registerTool('flashact_get_status', { inputSchema: { jobId } }, async args => response(() => engine.getStatus(args.jobId)));
  server.registerTool('flashact_cancel_job', { inputSchema: { jobId } }, async args => response(() => engine.cancelJob(args.jobId)));
  server.registerTool('flashact_get_result', { inputSchema: { jobId } }, async args => response(() => engine.getResult(args.jobId)));
  server.registerTool('flashact_run_benchmark', { inputSchema: { options: z.unknown().optional() } }, async args => response(() => benchmark(args.options ?? {})));
  return server;
}
