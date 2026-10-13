#!/usr/bin/env node
import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { JobEngine } from '../core/engine.js';
import { FlashActError } from '../utils/errors.js';
import { adapterOptions, commandPlan, connectionSchema, selectedTab } from './plan.js';
import { foreground, runEngineLifetime } from './foreground.js';
import { sendControl } from './ipc.js';
import { doctor } from './doctor.js';
import { benchmark } from './benchmark.js';

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

function connection(command: Command): Command {
  return command.option('--backend <backend>', 'playwright or aside', 'playwright')
    .option('--tab <id>', 'existing tab ID (required for Aside)')
    .option('--url <url>', 'exact target URL').option('--endpoint <endpoint>', 'browser connection endpoint')
    .option('--launch', 'explicitly launch a Playwright browser').option('--headless', 'headless launch');
}

async function usingEngine(input: unknown, action: (engine: JobEngine, signal: AbortSignal) => Promise<void>): Promise<void> {
  const { backend, scheduling } = connectionSchema.parse(input);
  const engine = new JobEngine({ adapterMode: 'owned', scheduling,
    adapterOptionsByBackend: { [backend]: adapterOptions(input) } });
  await runEngineLifetime(engine, signal => action(engine, signal));
}

export function createCli(): Command {
  const program = new Command().name('fa').enablePositionalOptions().version('0.1.0').description('Single-shot foreground browser actions');
  program.addHelpText('after', '\nLifecycle: fa --schedule/--watch/--arm run in the foreground until SIGINT/SIGTERM.\nKeep this process alive; fa --status/--cancel/--logs connects through private local IPC.\nShutdown cancels pending jobs and disconnects without closing existing tabs.\nFLASHACT_HOME defaults to ~/.flashact; only one engine may own each home.\n');
  connection(program.command('--doctor').alias('doctor')).action(async (input: unknown) => usingEngine(input, async engine => { print(await doctor(engine)); }));
  for (const name of ['connect', 'tabs']) {
    connection(program.command(`--${name}`).alias(name)).action(async (input: unknown) => usingEngine(input, async engine => {
      const options = connectionSchema.parse(input); print(await engine.listTabs(options.backend));
    }));
  }
  connection(program.command('--inspect').alias('inspect')).requiredOption('--selector <selector>', 'target CSS selector')
    .action(async (input: unknown) => usingEngine(input, async engine => {
      const options = connectionSchema.safeExtend({ selector: z.string() }).parse(input);
      print(await engine.inspectTarget(options.backend, await selectedTab(engine, options), options.selector));
    }));
  for (const name of ['schedule', 'watch', 'arm']) {
    const command = connection(program.command(`--${name}`).alias(name)).requiredOption('--approved-url <url>', 'explicit exact URL approval')
      .requiredOption('--action <action>', 'single-shot click only').option('--selector <selector>', 'target CSS selector')
      .option('--approve-irreversible', 'explicit irreversible-action approval').option('--timezone <IANA>', 'clock timezone', 'UTC')
      .option('--attribute <name>', 'attribute to observe').option('--value <value>', 'exact attribute/text value')
      .option('--scheduling <auto|browser|host>', 'scheduling policy (transport always owned)', 'auto')
      .option('--verify-selector <css>', 'verification CSS selector; omitted means local-click-only verification')
      .option('--verify-timeout-ms <integer>', 'positive safe-integer verification timeout in milliseconds', '5000')
      .option('--foreground', 'stay alive (always enabled; no daemon mode)');
    if (name !== 'watch') command.requiredOption('--at <time>', 'HH:mm:ss.SSS or offset ISO');
    if (name !== 'schedule') command.requiredOption('--when <condition>', 'enabled/appear/visible/attribute/text or #selector:enabled');
    command.action(async (input: unknown) => usingEngine(input, async (engine, signal) => {
      await foreground(engine, await commandPlan(engine, input), signal);
    }));
  }
  program.command('--status').alias('status').argument('[jobId]').action(async (id: string | undefined) => { print(await sendControl({ command: 'status', ...(id ? { jobId: id } : {}) })); });
  program.command('--cancel').alias('cancel').argument('<jobId>').action(async (id: string) => { print(await sendControl({ command: 'cancel', jobId: id })); });
  program.command('--logs').alias('logs').action(async () => { print(await sendControl({ command: 'logs' })); });
  program.command('--benchmark').alias('benchmark').option('--iterations <count>', 'benchmark iterations', '10')
    .option('--backend <backend>', 'playwright or aside', 'playwright').option('--mode <mode>', 'browser/node/cdp', 'browser')
    .option('--output <path>', 'report output').option('--tab <id>', 'explicit local Aside fixture tab')
    .action(async (input: unknown) => {
      const options = z.object({ iterations: z.coerce.number(), backend: z.string(), mode: z.string(),
        output: z.string().optional(), tab: z.string().optional() }).parse(input);
      print(await benchmark({ iterations: options.iterations, backend: options.backend, mode: options.mode,
        ...(options.output === undefined ? {} : { output: options.output }), ...(options.tab === undefined ? {} : { tabId: options.tab }) }));
    });
  program.command('--mcp').alias('mcp').option('--endpoint <endpoint>', 'Playwright CDP endpoint; Aside connects independently')
    .option('--scheduling <auto|browser|host>', 'scheduling policy (transport always owned)', 'auto')
    .option('--launch', 'launch a task-owned Playwright browser').option('--headless', 'headless Playwright launch')
    .option('--url <url>', 'exact target URL; prepares a page only with --launch')
    .action(async (input: unknown) => {
      const options = connectionSchema.parse(input);
      const { serveStdio } = await import('../mcp/index.js');
      await serveStdio({ scheduling: options.scheduling, adapterOptionsByBackend: { playwright: adapterOptions(options) } });
    });
  return program;
}

export async function main(argv = process.argv): Promise<void> {
  try { await createCli().parseAsync(argv); }
  catch (error) {
    const code = error instanceof FlashActError ? error.code : 'INTERNAL_ERROR';
    process.stderr.write(`${JSON.stringify({ error: code })}\n`); process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) await main();
