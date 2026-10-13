import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeSource } from '../dist/runtime/index.js';
import { runControlledProbe } from './controlled-hidden-probe.mjs';
import { hiddenTrial } from './hidden-latency-page.mjs';
import { finishHiddenReport, hiddenMatrix, hiddenRowSchema } from './hidden-latency-report.mjs';
import { reserveOutput, root } from './visible-latency-report.mjs';

export async function runHiddenBenchmark({ watchdogMs = 150000, createDriver } = {}) {
  const measurement = { attemptedTrials: 0, samples: [], activeTrial: null };
  const probe = await runControlledProbe({
    watchdogMs, ...(createDriver ? { createDriver } : {}),
    onNativeGate: async ({ report, pageCDP, browserCDP, original,
      command, observe, waitState, restore, signal }) => {
      report.command = 'node scripts/hidden-latency-benchmark.mjs (owned coordinator)';
      report.hiddenMeasurement = measurement;
      report.limitations[0] = 'Immediate native-hidden local latency; no population P99, SLA or site-acceptance claim.';
      const evaluate = async expression => {
        const reply = await command(pageCDP, 'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true, userGesture: false });
        assert(!reply.exceptionDetails && reply.result && 'value' in reply.result, 'Page evaluation must return a value');
        return reply.result.value;
      };
      const setup = await evaluate(`(() => {
        ${runtimeSource()};
        globalThis.__hiddenTrial = ${hiddenTrial.toString()};
        const auditStartIndex = globalThis.__controlledVisibilityAudit.length;
        globalThis.__hiddenEntry = new Promise(resolve => {
          const listener = event => {
            if (event.isTrusted && document.hidden && document.visibilityState === 'hidden') {
              document.removeEventListener('visibilitychange', listener);
              resolve({ hidden: document.hidden, visibilityState: document.visibilityState, isTrusted: event.isTrusted });
            }
          };
          document.addEventListener('visibilitychange', listener);
        });
        return { auditStartIndex, documentId: globalThis.__flashactRuntime.documentId };
      })()`);
      assert(Number.isSafeInteger(setup.auditStartIndex) && setup.auditStartIndex >= 0);
      measurement.documentId = setup.documentId;
      measurement.auditStartIndex = setup.auditStartIndex;
      report.nativeGate.minimizationAttempts++;
      report.restoration.status = 'pending';
      try {
        await command(browserCDP, 'Browser.setWindowBounds',
          { windowId: original.windowId, bounds: { windowState: 'minimized' } });
        measurement.beforeHidden = await waitState('hidden', 'before-hidden-measurement');
        assert(measurement.beforeHidden.agree && measurement.beforeHidden.cdp.hidden
          && measurement.beforeHidden.nativeBounds.windowState === 'minimized', 'Measurement minimization gate failed');
        measurement.entry = await evaluate('globalThis.__hiddenEntry');
        assert(measurement.entry.isTrusted && measurement.entry.hidden);
        for (const cell of hiddenMatrix) {
          for (let index = 0; index < cell.trials; index++) {
            signal.throwIfAborted();
            const options = { jobId: `hidden-${randomUUID()}`, scenario: cell.scenario,
              horizonMs: cell.horizonMs, auditStartIndex: setup.auditStartIndex };
            measurement.activeTrial = { ...options, state: 'IN_FLIGHT', outcome: 'UNKNOWN', retry: false };
            measurement.attemptedTrials++;
            report.measurementTrials = measurement.attemptedTrials;
            const row = hiddenRowSchema.parse(await evaluate(`globalThis.__hiddenTrial(${JSON.stringify(options)})`));
            assert.equal(row.jobId, options.jobId);
            assert.equal(row.scenario, options.scenario);
            measurement.samples.push(row);
            measurement.activeTrial = null;
            report.hiddenTrials = measurement.samples.filter(sample => sample.armReceipt && sample.validVisibility).length;
            assert(row.success, `Hidden trial ${row.jobId} failed; no retry`);
          }
        }
        measurement.afterHidden = await observe('after-hidden-measurement');
        const collection = await evaluate(`({
          audit: globalThis.__controlledVisibilityAudit.slice(${setup.auditStartIndex}),
          ledger: globalThis.__flashactFixture.ledger
        })`);
        measurement.visibilityAudit = collection.audit;
        measurement.finalLedger = collection.ledger;
        assert(measurement.afterHidden.agree && measurement.afterHidden.cdp.hidden
          && measurement.afterHidden.nativeBounds.windowState === 'minimized');
        assert(measurement.visibilityAudit.every(event => event.isTrusted && event.hidden
          && event.visibilityState === 'hidden'), 'Hidden visibility changed during measurement');
        assert.equal(measurement.finalLedger.length, measurement.samples.length, 'Fixture ledger must have one event per trial');
      } finally {
        if (!signal.aborted) {
          await restore();
          measurement.restoration = structuredClone(report.restoration);
          measurement.restorationVisibilityAudit = await evaluate(
            `globalThis.__controlledVisibilityAudit.slice(${setup.auditStartIndex})`);
          assert(measurement.restoration.status === 'restored' && measurement.restoration.boundsMatch,
            'Measurement restoration failed');
        } else measurement.restoration = { status: 'interrupted-child-termination-required', boundsMatch: false };
      }
    },
  });
  const result = finishHiddenReport(probe, measurement);
  const output = await reserveOutput(resolve(root, `artifacts/benchmark/hidden-latency-${probe.id}.json`));
  result.output = output.path;
  try { await output.write(result); }
  finally { await output.close(); }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 2, 'Usage: node scripts/hidden-latency-benchmark.mjs');
    const result = await runHiddenBenchmark();
    console.log(JSON.stringify({ status: result.status, output: result.output, probe: result.probePath,
      attemptedTrials: result.attemptedTrials, completedTrials: result.completedTrials,
      hiddenTrials: result.hiddenTrials, activeTrial: result.activeTrial,
      summary: result.summary, cells: result.cells, cleanupSuccess: result.cleanupSuccess, errors: result.errors }));
    if (result.status !== 'HIDDEN_MEASURED') process.exitCode = 1;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
