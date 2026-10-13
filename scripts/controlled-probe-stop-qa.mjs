import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runControlledProbe } from './controlled-hidden-probe.mjs';
import { createProbeDriver } from './controlled-probe-driver.mjs';
import { reserveOutput, root } from './visible-latency-report.mjs';

// Manual native shutdown controls, separate from the visibility gate. Each
// scenario owns a new Chrome/profile/report and runs only after the prior join.
const receipts = [];
for (const scenario of ['pending-evaluate-SIGINT', 'late-attach-SIGINT', 'pending-evaluate-watchdog']) {
  let held;
  const withheld = [];
  const method = scenario === 'late-attach-SIGINT' ? 'Browser.getVersion' : 'Runtime.evaluate';
  const report = await runControlledProbe({
    watchdogMs: scenario.endsWith('watchdog') ? 6000 : 60000,
    createDriver: options => createProbeDriver({
      ...options,
      workerURL: new URL('../tests/fixtures/controlled-probe-held-response.mjs', import.meta.url),
      workerData: { method },
      onProtocol: record => {
        options.onProtocol(record);
        if (record.direction === 'withheld') {
          withheld.push(record);
          if (!held) {
            held = record;
            if (scenario.endsWith('SIGINT')) process.kill(process.pid, 'SIGINT');
          }
        }
      },
    }),
  });
  assert(held, `${scenario}: did not observe an actual withheld response`);
  assert.equal(withheld.length, 1, 'Hold exactly one actual protocol response');
  assert.equal(report.lifecycle.stopReason, scenario.endsWith('SIGINT') ? 'SIGINT' : 'watchdog');
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.cleanupSuccess, true);
  assert.deepEqual(report.lifecycle.pending, []);
  assert.equal(report.teardown.driver, 'closed');
  assert.equal(report.teardown.child, 'closed');
  assert.equal(report.teardown.profile, 'removed-after-child-exit');
  assert.equal(report.hashManifest.unchanged, true);
  assert.equal(report.hiddenTrials, 0);
  assert(report.finishedAt);
  await assert.rejects(stat(report.profile.path), error => error.code === 'ENOENT');
  assert.throws(() => process.kill(report.child.pid, 0), error => error.code === 'ESRCH');
  receipts.push({ scenario, output: report.reportPath, held, status: report.status,
    stopReason: report.lifecycle.stopReason, cleanupSuccess: report.cleanupSuccess,
    child: report.child.exit, driver: report.driverExit, teardown: report.teardown,
    preservation: report.hashManifest.unchanged });
  console.log(JSON.stringify(receipts.at(-1)));
}
const output = await reserveOutput(resolve(root, `artifacts/qa/controlled-probe-stop-${randomUUID()}.json`));
try { await output.write({ status: 'SHUTDOWN_CONTROLS_VERIFIED', receipts }); }
finally { await output.close(); }
console.log(JSON.stringify({ status: 'SHUTDOWN_CONTROLS_VERIFIED', output: output.path }));
