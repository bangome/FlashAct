import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NodeScheduler } from '../dist/core/scheduler/node-scheduler.js';
import { runtimeSource } from '../dist/runtime/index.js';
import { RuntimeJobs } from '../dist/adapters/playwright/runtime-jobs.js';
import { createProbeDriver, scheduleProbeOperation } from './controlled-probe-driver.mjs';
import { runControlledProbe } from './controlled-hidden-probe.mjs';
import { hiddenTrial } from './hidden-latency-page.mjs';
import { prepareExternal, dispatchExternal, prepareGuarded } from './hidden-scheduling-page.mjs';
import { summarizeVisible } from './visible-latency-page.mjs';
import { reserveOutput, root } from './visible-latency-report.mjs';

const comparison = { samples: [], attemptedTrials: 0, activeTrial: null };
const scheduler = new NodeScheduler();
const args = process.argv.slice(2);
assert(args.length <= 1 && (args.length === 0 || args[0] === '--guarded-wake'));
const guarded = args[0] === '--guarded-wake';
const paths = guarded ? ['browser-timer', 'host-wake'] : ['browser-timer', 'host-cdp'];
const commandLabel = `node scripts/hidden-scheduling-comparison.mjs${guarded ? ' --guarded-wake' : ''}`;
let jobs, markNextWake = false;
const scheduled = (at, signal, operation) => scheduleProbeOperation(scheduler, at, signal, operation);
const probe = await runControlledProbe({
  watchdogMs: 150000,
  createDriver: options => createProbeDriver({ ...options, onProtocol: record => {
    options.onProtocol(record);
    if (record.direction === 'receive' && record.method === 'Runtime.consoleAPICalled') {
      const text = record.params.args[0]?.value;
      if (typeof text === 'string') jobs?.receive(text);
    }
  } }),
  onNativeGate: async ({ report, page, pageCDP, browserCDP, original, command, stage, observe, waitState, restore, signal }) => {
    report.command = `${commandLabel} (owned coordinator)`;
    report.hiddenSchedulingComparison = comparison;
    report.limitations[0] = guarded
      ? 'Actual compiled runtime through RuntimeJobs/public SDK evaluate; caller-owned opt-in host wake, not SLA.'
      : 'Controlled hidden scheduling comparison; host baseline is fixture-only, not runtime verification or SLA.';
    const evaluate = async expression => {
      const reply = await command(pageCDP, 'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, userGesture: false });
      assert(!reply.exceptionDetails && reply.result && 'value' in reply.result);
      return reply.result.value;
    };
    const setup = await evaluate(`(() => {
      ${runtimeSource()};
      globalThis.__hiddenTrial = ${hiddenTrial.toString()};
      globalThis.__prepareExternal = ${prepareExternal.toString()};
      globalThis.__dispatchExternal = ${dispatchExternal.toString()};
      globalThis.__prepareGuarded = ${prepareGuarded.toString()};
      const auditStartIndex = globalThis.__controlledVisibilityAudit.length;
      globalThis.__comparisonEntry = new Promise(resolve => {
        const listener = event => {
          if (event.isTrusted && document.hidden) {
            document.removeEventListener('visibilitychange', listener);
            resolve({ isTrusted: event.isTrusted, hidden: document.hidden });
          }
        };
        document.addEventListener('visibilitychange', listener);
      });
      return { auditStartIndex };
    })()`);
    assert(Number.isSafeInteger(setup.auditStartIndex));
    if (guarded) jobs = new RuntimeJobs((_tabId, expression) => {
      const entry = markNextWake;
      markNextWake = false;
      const measured = entry ? `(() => { globalThis.__comparisonWakeEntry = performance.timeOrigin + performance.now(); return ${expression}; })()` : expression;
      return stage('guarded-adapter-evaluate', () => page.evaluate(measured));
    });
    report.nativeGate.minimizationAttempts++;
    report.restoration.status = 'pending';
    try {
      await command(browserCDP, 'Browser.setWindowBounds',
        { windowId: original.windowId, bounds: { windowState: 'minimized' } });
      comparison.beforeHidden = await waitState('hidden', 'before-scheduling-comparison');
      assert(comparison.beforeHidden.agree && comparison.beforeHidden.cdp.hidden
        && comparison.beforeHidden.nativeBounds.windowState === 'minimized');
      const entry = await evaluate('globalThis.__comparisonEntry');
      assert(entry.isTrusted && entry.hidden);
      for (let pair = 0; pair < 20; pair++) {
        const order = pair % 2 === 0 ? paths : [...paths].reverse();
        for (const path of order) {
          signal.throwIfAborted();
          const options = { jobId: `comparison-${randomUUID()}`, scenario: 'scheduled',
            horizonMs: guarded ? 1000 : 12, auditStartIndex: setup.auditStartIndex, path };
          comparison.activeTrial = { ...options, path, state: 'IN_FLIGHT', outcome: 'UNKNOWN', retry: false };
          comparison.attemptedTrials++;
          report.measurementTrials = comparison.attemptedTrials;
          let row;
          if (guarded) {
            const prepared = await evaluate(`globalThis.__prepareGuarded(${JSON.stringify(options)})`);
            await jobs.install(prepared.plan);
            await jobs.arm(prepared.plan);
            const armed = await jobs.status(options.jobId);
            assert.equal(armed.state, 'WAITING', 'Setup must finish before the shared future deadline');
            const completion = evaluate('globalThis.__comparisonCompleted');
            const wake = path === 'host-wake'
              ? scheduled(prepared.targetWallEpochMs, signal, () => { markNextWake = true; return jobs.wake(options.jobId); })
              : Promise.resolve(null);
            // Do not abandon the other producer if one command rejects.
            const settled = await Promise.allSettled([completion, wake]);
            for (const item of settled) if (item.status === 'rejected') throw item.reason;
            row = settled[0].value;
            if (path === 'host-wake') {
              row.hostDispatchWallMs = settled[1].value.hostDispatchWallMs;
              row.wakeAcknowledgement = settled[1].value.value;
              assert.equal(row.wakeAcknowledgement.executions, 1);
              assert.equal(row.wakeAcknowledgement.state, 'VERIFIED');
            }
            assert.equal((await jobs.status(options.jobId)).executions, 1);
          } else if (path === 'browser-timer') {
            row = await evaluate(`globalThis.__hiddenTrial(${JSON.stringify(options)})`);
            row.path = path;
          } else {
            const prepared = await evaluate(`globalThis.__prepareExternal(${JSON.stringify(options)})`);
            assert.equal(prepared.jobId, options.jobId);
            assert(Number.isFinite(prepared.targetWallEpochMs));
            const result = await scheduled(prepared.targetWallEpochMs, signal,
              () => evaluate(`globalThis.__dispatchExternal(${JSON.stringify(options.jobId)})`));
            row = { ...result.value, hostDispatchWallMs: result.hostDispatchWallMs };
          }
          assert.equal(row.jobId, options.jobId);
          assert.equal(row.clicks.length, 1);
          assert(Number.isFinite(row.latencyMs));
          comparison.samples.push(row);
          comparison.activeTrial = null;
          report.hiddenTrials = comparison.samples.filter(sample => sample.validVisibility).length;
          assert(row.success, 'Comparison failed without retry');
        }
      }
      comparison.afterHidden = await observe('after-scheduling-comparison');
      const final = await evaluate(`({
        audit:globalThis.__controlledVisibilityAudit.slice(${setup.auditStartIndex}),
        ledger:globalThis.__flashactFixture.ledger
      })`);
      comparison.visibilityAudit = final.audit;
      comparison.finalLedger = final.ledger;
      assert(comparison.afterHidden.agree && comparison.afterHidden.cdp.hidden
        && comparison.afterHidden.nativeBounds.windowState === 'minimized');
      assert(final.audit.length > 0 && final.audit.every(event => event.isTrusted && event.hidden));
      assert.equal(final.ledger.length, 40);
    } finally {
      if (!signal.aborted) {
        await restore();
        comparison.restoration = structuredClone(report.restoration);
        assert(comparison.restoration.status === 'restored' && comparison.restoration.boundsMatch);
      } else comparison.restoration = { status: 'interrupted-child-termination-required' };
    }
  },
});
const cells = paths.map(path => ({ path,
  ...summarizeVisible(comparison.samples.filter(row => row.path === path)) }));
const complete = probe.status === 'HIDDEN_GATE_VERIFIED' && probe.cleanupSuccess && probe.hashManifest?.unchanged
  && comparison.activeTrial === null && cells.every(cell => cell.count === 20 && cell.successes === 20
    && cell.dupCount === 0 && cell.earlyWallGuardViolations === 0 && cell.negativeBeyondUncertainty === 0)
  && new Set(comparison.samples.map(row => row.jobId)).size === 40;
const result = { status: complete ? 'HIDDEN_SCHEDULING_COMPARISON_COMPLETE' : 'BLOCKED_OR_PARTIAL',
  command: commandLabel, guarded, probe: probe.reportPath,
  runtimeSha256: probe.runtimeSha256, cells, ...comparison,
  nativeGate: probe.nativeGate, cleanupSuccess: probe.cleanupSuccess, preservation: probe.hashManifest?.unchanged,
  errors: probe.errors, stopReason: probe.lifecycle.stopReason,
  limitations: ['Same native-hidden page, balanced interleaved order,20 per path; no P99/SLA.',
    guarded ? 'Both cells execute the same guarded runtime; production-equivalent RuntimeJobs and public Playwright evaluate.'
      : 'Host baseline clicks the guarded local cached fixture directly; not full runtime verification.',
    guarded ? 'Future deadline1000ms provides SDK installation lead; not comparable to the12ms prototype as a paired result.'
      : 'Both prototype cells have12ms horizon.',
    'Host/browser Date clocks share this local machine; no remote-clock portability claim.',
    'No causal CPU profiling, hidden aging, site acceptance, retry or post-stop salvage.'] };
const output = await reserveOutput(resolve(root, `artifacts/benchmark/hidden-scheduling-comparison-${probe.id}.json`));
try { await output.write(result); }
finally { await output.close(); }
console.log(JSON.stringify({ status: result.status, output: output.path, probe: result.probe,
  cells, cleanupSuccess: result.cleanupSuccess, errors: result.errors }));
if (!complete) process.exitCode = 1;
