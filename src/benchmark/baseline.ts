import { z } from 'zod';
import type { Page } from 'playwright';
import { NodeScheduler } from '../core/scheduler/node-scheduler.js';
import { baselineReceiptSchema, sampleSchema } from './statistics.js';
import type { BenchmarkSample } from './statistics.js';

export async function runBaseline(page: Page, options: {readonly mode: 'node' | 'cdp'; readonly iterations: number}) {
  const hostNow = (): number => performance.timeOrigin + performance.now();
  const calibration = [];
  for (let i = 0; i < 15; i++) {
    const before = hostNow();
    const pageNow = z.number().parse(await page.evaluate('performance.timeOrigin + performance.now()'));
    const after = hostNow();
    calibration.push({offsetMs: pageNow - (before + after) / 2, uncertaintyMs: (after - before) / 2});
  }
  calibration.sort((a, b) => a.uncertaintyMs - b.uncertaintyMs);
  const best = calibration[0];
  if (!best) throw new RangeError('Clock calibration requires samples');
  const session = options.mode === 'cdp' ? await page.context().newCDPSession(page) : undefined;
  const samples: BenchmarkSample[] = [];
  const scheduler = new NodeScheduler();
  await page.evaluate('globalThis.__benchButton = document.querySelector("#reserve")');
  try {
    for (let i = 0; i < options.iterations; i++) {
      const jobId = `baseline-${options.mode}-${i}`;
      await page.evaluate(`globalThis.__flashactFixture.reset(${JSON.stringify(jobId)},true)`);
      const referenceHost = hostNow();
      const referenceWall = Date.now();
      const target = referenceWall + 12;
      const pageTarget = referenceHost + 12 + best.offsetMs;
      const expression = `(() => {const receivedEpochMs = performance.timeOrigin + performance.now(); globalThis.__benchButton.click(); return JSON.stringify({receivedEpochMs,clicks:globalThis.__flashactFixture.ledger.filter(x=>x.jobId===${JSON.stringify(jobId)})});})()`;
      let cancel = (): void => {};
      try {
        const result = await new Promise<{readonly receipt: unknown; readonly schedulerEpochMs: number; readonly hostDispatchEpochMs: number}>((resolve, reject) => {
          cancel = scheduler.schedule(target, () => {
            const schedulerEpochMs = hostNow() + best.offsetMs;
            const hostDispatchEpochMs = Date.now();
            const dispatch = session
              ? session.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}).then(response => response.result.value)
              : page.evaluate(expression);
            void dispatch.then(receipt => resolve({receipt, schedulerEpochMs, hostDispatchEpochMs}), reject);
          });
        });
        const decoded: unknown = JSON.parse(z.string().parse(result.receipt));
        const receipt = baselineReceiptSchema.parse(decoded);
        samples.push(sampleSchema.parse({jobId, scenario: `${options.mode}-scheduled`,
          targetEpochMs: pageTarget, ...receipt, schedulerEpochMs: result.schedulerEpochMs,
          hostTargetEpochMs: target, hostDispatchEpochMs: result.hostDispatchEpochMs,
          targetUncertaintyMs: best.uncertaintyMs + 1}));
      } finally { cancel(); }
    }
    const uncertaintyMs = best.uncertaintyMs + 1;
    return {samples, clockCalibration: {method: 'minimum-RTT midpoint, 15 samples; Date guard projection adds 1ms quantization uncertainty', ...best,
      totalUncertaintyMs: uncertaintyMs, earlyBeyondUncertainty: samples.filter(sample => (sample.clicks[0]?.epochMs ?? Infinity) - sample.targetEpochMs < -uncertaintyMs).length,
      samples: calibration},
      teardown: {cancelledTimers: samples.length, cdpDetached: session !== undefined}};
  } finally { await session?.detach(); }
}
