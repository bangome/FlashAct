import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { FlashActError, JobEngine, PlaywrightAdapter, parsePlan } from '../dist/index.js';

const rows = [];
for (const mode of ['recoverable', 'unrecoverable']) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent('<button id="reserve" type="button" onclick="window.clicks=(window.clicks||0)+1">Local fault-injection fixture</button>');
  const adapter = new PlaywrightAdapter({ page });
  const originals = { arm: adapter.arm.bind(adapter), cancel: adapter.cancel.bind(adapter), getStatus: adapter.getStatus.bind(adapter) };
  const engine = new JobEngine({ adapters: { playwright: adapter } });
  try {
    const tab = (await engine.listTabs('playwright'))[0];
    if (!tab) throw new Error('Owned tab missing');
    const plan = parsePlan({ schemaVersion: '1.0', jobId: `lost-ack-${mode}`, name: 'Local fault injection', backend: 'playwright',
      target: { tabId: tab.id, selector: '#reserve', url: 'about:blank' }, trigger: { type: 'ELEMENT_ENABLE', selector: '#reserve' },
      action: { type: 'click' }, timezone: 'UTC', expiresAt: Date.now() + 10000, maxExecutions: 1,
      verification: { timeoutMs: 1000 }, guards: { approvedUrl: 'about:blank', allowIrreversible: false } });
    await engine.createJob(plan); await engine.validateJob(plan.jobId);
    adapter.arm = async input => { await originals.arm(input); throw new FlashActError('ADAPTER_ERROR', 'Injected lost arm acknowledgement'); };
    adapter.cancel = async () => { throw new FlashActError('ADAPTER_ERROR', 'Injected cancel transport loss'); };
    if (mode === 'unrecoverable') adapter.getStatus = async () => { throw new FlashActError('ADAPTER_ERROR', 'Injected status transport loss'); };
    let armError;
    try { await engine.armJob(plan.jobId); }
    catch (error) { if (!(error instanceof FlashActError)) throw error; armError = error.code; }
    const status = await engine.getStatus(plan.jobId);
    const independentClicks = await page.evaluate('window.clicks');
    let rearmError;
    try { await engine.armJob(plan.jobId); }
    catch (error) { if (!(error instanceof FlashActError)) throw error; rearmError = error.code; }
    const expected = mode === 'recoverable' ? 'VERIFIED' : 'UNKNOWN';
    if (status.state !== expected || independentClicks !== 1 || armError !== 'ADAPTER_ERROR' || rearmError !== 'INVALID_STATE') throw new Error('Lost acknowledgement safety contract failed');
    if (mode === 'recoverable' && status.executions !== 1) throw new Error('Observed execution was lost');
    rows.push({ mode, armError, status, independentClicks, rearmError });
  } finally {
    adapter.arm = originals.arm; adapter.cancel = originals.cancel; adapter.getStatus = originals.getStatus;
    await engine.close(); await browser.close();
  }
}
await mkdir('artifacts/qa', { recursive: true });
const report = { rows, note: 'UNKNOWN executions is a last-observed count, not a claim of no side effects', teardown: 'Both fault-injection adapters restored, engines closed, owned Chromium browsers closed' };
await writeFile('artifacts/qa/lost-ack-after.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
