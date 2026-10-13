import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runHiddenBenchmark } from './hidden-latency-benchmark.mjs';
import { createProbeDriver } from './controlled-probe-driver.mjs';
import { reserveOutput, root } from './visible-latency-report.mjs';

const receipts = [];
for (const scenario of ['gate-SIGINT', 'in-flight-SIGINT', 'in-flight-watchdog']) {
  const gateControl = scenario === 'gate-SIGINT';
  const method = gateControl ? 'Browser.setWindowBounds' : 'Runtime.evaluate';
  const expressionPrefix = gateControl ? undefined : 'globalThis.__hiddenTrial(';
  let held;
  const result = await runHiddenBenchmark({
    watchdogMs: scenario.endsWith('watchdog') ? 8000 : 150000,
    createDriver: options => createProbeDriver({
      ...options,
      workerURL: new URL('../tests/fixtures/controlled-probe-held-response.mjs', import.meta.url),
      workerData: { method, expressionPrefix },
      onProtocol: record => {
        options.onProtocol(record);
        if (record.direction === 'withheld' && !held) {
          held = record;
          if (scenario.endsWith('SIGINT')) process.kill(process.pid, 'SIGINT');
        }
      },
    }),
  });
  assert(held, `${scenario}: missing actual withheld reply`);
  assert.equal(result.status, 'BLOCKED_OR_PARTIAL');
  assert.equal(result.stopReason, scenario.endsWith('SIGINT') ? 'SIGINT' : 'watchdog');
  assert.equal(result.cleanupSuccess, true);
  assert.equal(result.preservation, true);
  assert.equal(result.completedTrials, 0);
  assert.equal(result.hiddenTrials, 0); // No completed hidden reply, not a zero-execution claim.
  assert.equal(result.attemptedTrials, gateControl ? 0 : 1);
  if (gateControl) {
    assert.equal(result.nativeGate.passed, false);
    assert.equal(result.activeTrial, null);
  } else {
    assert.equal(result.nativeGate.passed, true);
    assert.equal(result.activeTrial.state, 'IN_FLIGHT');
    assert.equal(result.activeTrial.outcome, 'UNKNOWN');
    assert.equal(result.activeTrial.retry, false);
  }
  assert.deepEqual(result.pending, []);
  assert.equal(result.teardown.child, 'closed');
  assert.equal(result.teardown.driver, 'closed');
  assert.equal(result.teardown.profile, 'removed-after-child-exit');
  assert.throws(() => process.kill(result.ownership.childPid, 0), error => error.code === 'ESRCH');
  await assert.rejects(stat(result.ownership.profile), error => error.code === 'ENOENT');
  // Reuse the raw coordinator receipt for exact PID/profile ownership, not a
  // post-stop page query. Its data is retained in the final summary below.
  receipts.push({ scenario, held, output: result.output, probe: result.probePath,
    stopReason: result.stopReason, attemptedTrials: result.attemptedTrials,
    completedTrials: result.completedTrials, activeTrial: result.activeTrial,
    cleanupSuccess: result.cleanupSuccess, preservation: result.preservation,
    ownership: result.ownership, teardown: result.teardown, driverExit: result.driverExit });
  console.log(JSON.stringify(receipts.at(-1)));
}
const output = await reserveOutput(resolve(root, `artifacts/qa/hidden-latency-stop-${randomUUID()}.json`));
try { await output.write({ status: 'HIDDEN_MEASUREMENT_STOP_CONTROLS_VERIFIED', receipts }); }
finally { await output.close(); }
console.log(JSON.stringify({ status: 'HIDDEN_MEASUREMENT_STOP_CONTROLS_VERIFIED', output: output.path }));
