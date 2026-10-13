import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runVisible } from './visible-latency-runner.mjs';

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, strict: true, options: {
    output: { type: 'string' }, 'watchdog-ms': { type: 'string', default: '150000' },
    'drain-ms': { type: 'string', default: '8000' }, control: { type: 'boolean', default: false },
  } });
  const watchdogMs = Number(values['watchdog-ms']), drainMs = Number(values['drain-ms']);
  if (![watchdogMs, drainMs].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 150000)) {
    throw new Error('Watchdog/drain settings must be integers in [1, 150000] ms');
  }
  const report = await runVisible({ output: values.output, watchdogMs, drainMs, control: values.control,
    command: ['node', 'scripts/visible-latency-benchmark.mjs', ...args].join(' ') });
  if (report.status !== 'VISIBLE VERIFIED') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    console.error(JSON.stringify({ status: 'FAILED', error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
