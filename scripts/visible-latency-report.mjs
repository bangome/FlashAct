import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeVisible } from './visible-latency-page.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const preserved = ['artifacts/benchmark/playwright-hidden.json', 'artifacts/benchmark/playwright-browser.json',
  'artifacts/benchmark/aside-browser.json', 'artifacts/benchmark/playwright-node.json',
  'artifacts/benchmark/playwright-cdp.json', 'artifacts/benchmark/hidden-state-probe.json',
  'artifacts/benchmark/visible-latency.json', 'flashact-0.1.0.tgz', 'package.json', 'package-lock.json',
  'tsconfig.json', 'tsconfig.test.json'];
export const matrix = Object.freeze([{ scenario: 'scheduled', horizonMs: 12, trials: 10 },
  { scenario: 'scheduled', horizonMs: 1000, trials: 5 },
  { scenario: 'scheduled', horizonMs: 8000, trials: 5 },
  { scenario: 'reactive', horizonMs: 1000, trials: 5 }].map(Object.freeze));
export const launchOptions = Object.freeze({ headless: false, timeout: 15000,
  handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, ignoreDefaultArgs: [
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
export const errorText = error => error instanceof Error ? error.message : String(error);
export const digest = value => createHash('sha256').update(value).digest('hex');

export async function hashes() {
  return Object.fromEntries(await Promise.all(preserved.map(async path => [path, digest(await readFile(resolve(root, path)))])));
}

export async function reserveOutput(requested) {
  const path = resolve(requested ?? resolve(root, `artifacts/benchmark/visible-latency-${randomUUID()}.json`));
  const canonical = resolve(await realpath(dirname(path)), basename(path));
  const protectedPaths = await Promise.all(preserved.map(path => realpath(resolve(root, path))));
  if (protectedPaths.includes(canonical)) throw new Error(`Protected output path: ${canonical}`);
  // Exclusive creation rejects existing files, symlinks and hardlink aliases alike.
  const file = await open(canonical, 'wx', 0o600);
  return { path: canonical, close: () => file.close(), write: async report => {
    const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    // FileHandle.writeFile with an explicit position is unavailable; reset through truncate
    // plus positional writes, retaining the exclusively created inode throughout the run.
    let offset = 0;
    while (offset < bytes.length) offset += (await file.write(bytes, offset, bytes.length - offset, offset)).bytesWritten;
    await file.truncate(bytes.length);
    await file.sync();
  } };
}

export function createReport(options, source) {
  const selected = options.control ? [{ scenario: 'scheduled', horizonMs: 12, trials: 1 }] : matrix;
  const planned = selected.reduce((count, cell) => count + cell.trials, 0);
  return { status: 'PARTIAL', scope: 'VISIBLE ONLY', startedAt: new Date().toISOString(),
    command: options.command ?? 'runVisible', childReportPath: options.output, nodeVersion: process.version,
    launchOptions, requestedLaunchArguments: [], fullLaunchArguments: null,
    flagDisclosure: 'Requested ignore flags match native probe. Remaining defaults are not stock Chrome; complete arguments may be unavailable.',
    runtimeSha256: digest(source), matrix: selected, plannedMatrixTrials: planned + 25, plannedVisibleTrials: planned,
    completedVisibleTrials: 0, hiddenRows: { status: 'NOT VERIFIED', completedTrials: 0, skippedPlannedTrials: 25,
      reference: 'artifacts/benchmark/hidden-state-probe.json', nativeGate: 'BLOCKED' },
    normalPlannedWaitMs: options.control ? 12 : 50120, watchdogMs: options.watchdogMs ?? 150000,
    samples: [], errors: [], activeTrial: null,
    method: 'Serial document-local cached-target synthetic clicks; independent authored fixture event ledger. No host IPC in measured path.',
    limits: ['Small cells: descriptive statistics, no population P99 or SLA.',
      'Native document visibility is not physical occlusion, background-tab, sleep/wake or site acceptance evidence.',
      'Adjacent performance epoch/Date anchors: uncertainty is anchor half-span plus 1 ms wall quantization, not clock drift.',
      'Reactive E0 follows the real native setter; E1 is available runtime observerEpochMs, not independent observer attribution.',
      'Cancellation is not undo. An aborted row retains only last host-observed evidence; no post-stop page salvage.',
      'Unreachable native library operations may never settle; a drain diagnostic is not a termination guarantee.'] };
}

export function finishReport(report, lifecycle) {
  report.lifecycle = lifecycle;
  report.teardown = lifecycle.teardown;
  report.cleanupSuccess = lifecycle.cleanupSuccess;
  report.errors.push(...lifecycle.errors);
  report.cells = report.matrix.map(cell => ({ ...cell, ...summarizeVisible(report.samples.filter(row =>
    row.scenario === cell.scenario && row.horizonMs === cell.horizonMs)) }));
  report.summary = summarizeVisible(report.samples);
  report.status = report.completedVisibleTrials === report.plannedVisibleTrials && report.summary.failures === 0
    && !lifecycle.stopReason && report.errors.length === 0 && report.cleanupSuccess && report.hashManifest?.unchanged
    ? 'VISIBLE VERIFIED' : 'PARTIAL_OR_FAILED';
  report.finishedAt = new Date().toISOString();
  return structuredClone(report);
}
