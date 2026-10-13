import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { runControlledProbe } from './controlled-hidden-probe.mjs';
import { createProbeDriver } from './controlled-probe-driver.mjs';
import { reserveOutput, root } from './visible-latency-report.mjs';

const inspect = promisify(execFile);
assert(process.argv.length === 2 || (process.argv.length === 3
  && ['--post-only', '--final-only'].includes(process.argv[2])),
  'Usage: node scripts/native-visibility-investigation.mjs [--post-only|--final-only]');
const preObserve = process.argv.length === 2;
const finalOnly = process.argv[2] === '--final-only';
const native = { observations: [], ownership: null, errors: [] };
const outputPath = resolve(root, `artifacts/qa/native-visibility-${randomUUID()}.json`);

async function bind(endpoint, options) {
  const url = new URL(endpoint);
  assert.equal(url.hostname, '127.0.0.1');
  const listener = await inspect('/usr/sbin/lsof',
    ['-nP', '-a', `-iTCP:${url.port}`, '-sTCP:LISTEN', '-Fp'], { timeout: 3000 });
  const pids = [...new Set(listener.stdout.trim().split(/\r?\n/).filter(line => /^p\d+$/.test(line))
    .map(line => Number(line.slice(1))))];
  assert.equal(pids.length, 1, 'Bind exactly one fresh endpoint listener');
  const pid = pids[0];
  const process = await inspect('/bin/ps', ['-ww', '-p', String(pid), '-o', 'pid=', '-o', 'command='],
    { timeout: 3000 });
  assert(options.artifactsDir.includes('/flashact-controlled-'));
  assert(process.stdout.includes(`--user-data-dir=${options.artifactsDir}`));
  assert(process.stdout.includes('--remote-debugging-address=127.0.0.1'));
  assert(process.stdout.includes('Google Chrome for Testing'));
  native.ownership = { pid, endpoint, profile: options.artifactsDir, argv: process.stdout.trim() };
}

async function observe(phase, params) {
  try {
    const result = await inspect('orca',
      ['computer', 'list-windows', '--app', `pid:${native.ownership.pid}`, '--json'],
      { timeout: 3000, maxBuffer: 1024 * 1024 });
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.ok, true, 'Native window listing must succeed');
    assert.equal(receipt.result.app.pid, native.ownership.pid, 'Native app must match the bound PID');
    assert(receipt.result.windows.every(window => window.app.pid === native.ownership.pid),
      'Native window listing must contain only owned windows');
    native.observations.push({ phase, at: new Date().toISOString(), params,
      stdout: receipt, stderr: result.stderr });
  } catch (error) {
    native.errors.push({ phase, message: error.message, stdout: error.stdout, stderr: error.stderr });
  }
}

let report;
let output;
try {
  report = await runControlledProbe({
    createDriver: options => {
      const driver = createProbeDriver(options);
      return {
        get stopped() { return driver.stopped; },
        joined: driver.joined,
        cancel: () => driver.cancel(),
        invoke: async (command, args = []) => {
          if (command === 'attach') await bind(...args);
          const windowChange = command === 'send' && args[1] === 'Browser.setWindowBounds';
          if (windowChange && preObserve) await observe('before-window-command', args[2]);
          const result = await driver.invoke(command, args);
          if (windowChange && (!finalOnly || args[2].bounds.windowState === undefined)) {
            await observe('after-window-command', args[2]);
          }
          return result;
        },
      };
    },
  });
} finally {
  // Create this separate owned output after the coordinator's preservation
  // snapshot, so it is not incorrectly included as an immutable input file.
  output = await reserveOutput(outputPath);
  try {
    await output.write({
      command: `node scripts/native-visibility-investigation.mjs${process.argv[2] ? ` ${process.argv[2]}` : ''}`,
      status: report ? (native.errors.length ? 'NATIVE_OBSERVATION_BLOCKED' : 'NATIVE_STATE_OBSERVED') : 'INCOMPLETE',
      preObserve,
      finalOnly,
      method: 'Independent macOS window-list observations via Orca scoped to fresh owned endpoint/profile/PID; no native action or latency',
      native,
      probe: report ? { output: report.reportPath, status: report.status, provenance: report.provenance,
        nativeGate: report.nativeGate, restoration: report.restoration, cleanupSuccess: report.cleanupSuccess,
        preservation: report.hashManifest?.unchanged, hiddenTrials: report.hiddenTrials, errors: report.errors } : null,
    });
  } finally { await output.close(); }
}
console.log(JSON.stringify({ output: output.path, native, probe: report?.reportPath,
  nativeGate: report?.nativeGate, cleanupSuccess: report?.cleanupSuccess }));
if (!report?.cleanupSuccess || native.errors.length) process.exitCode = 1;
