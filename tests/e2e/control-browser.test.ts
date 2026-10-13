import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { PlaywrightAdapter } from '../../src/adapters/playwright/index.js';
import { JobEngine } from '../../src/core/engine.js';

it('clicks once through the injected runtime and preserves an existing tab on shutdown', async () => {
  // Given
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('about:blank');
  await page.setContent('<button id="reserve" onclick="this.dataset.count=String(Number(this.dataset.count||0)+1); document.body.insertAdjacentHTML(\'beforeend\',\'<span id=done>done</span>\')">reserve</button>');
  const adapter = new PlaywrightAdapter({ page });
  const engine = new JobEngine({ adapters: { playwright: adapter } });
  const tab = (await engine.listTabs('playwright'))[0];
  if (!tab) throw new Error('No fixture tab');
  const plan = { schemaVersion: '1.0', jobId: 'browser-job', name: 'fixture', backend: 'playwright',
    target: { tabId: tab.id, selector: '#reserve', url: 'about:blank' },
    trigger: { type: 'ELEMENT_ENABLE', selector: '#reserve' }, action: { type: 'click' }, timezone: 'UTC',
    expiresAt: Date.now() + 10000, maxExecutions: 1, verification: { selector: '#done', timeoutMs: 1000 },
    guards: { approvedUrl: 'about:blank', allowIrreversible: false } };
  try {
    await engine.createJob(plan); await engine.validateJob('browser-job');
    // When
    await engine.armJob('browser-job'); await page.waitForSelector('#done');
    const result = await engine.getResult('browser-job');
    await engine.close();
    // Then
    expect(result).toMatchObject({ executions: 1, state: 'VERIFIED' });
    expect(page.isClosed()).toBe(false);
    expect(await page.locator('#reserve').getAttribute('data-count')).toBe('1');
  } finally { await engine.close(); await browser.close(); }
}, 15000);

it.each([
  { operation: 'status', read: (engine: JobEngine) => engine.getStatus('lost-tab') },
  { operation: 'cancel', read: (engine: JobEngine) => engine.cancelJob('lost-tab') },
])('returns retained uncertainty through $operation when an armed tab closes without a runtime receipt', async ({ read }) => {
  // Given
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const adapter = new PlaywrightAdapter({ page });
  const engine = new JobEngine({ adapters: { playwright: adapter } });
  try {
    await page.setContent('<button id="reserve" disabled>reserve</button>');
    const tab = (await engine.listTabs('playwright'))[0];
    if (!tab) throw new Error('No owned fixture tab');
    await engine.createJob({ schemaVersion: '1.0', jobId: 'lost-tab', name: 'closed fixture', backend: 'playwright',
      target: { tabId: tab.id, selector: '#reserve', url: 'about:blank' },
      trigger: { type: 'ELEMENT_ENABLE', selector: '#reserve' }, action: { type: 'click' }, timezone: 'UTC',
      expiresAt: Date.now() + 60000, maxExecutions: 1, verification: { timeoutMs: 1000 },
      guards: { approvedUrl: 'about:blank', allowIrreversible: false } });
    await engine.validateJob('lost-tab'); await engine.armJob('lost-tab');
    // When
    await page.close();
    const status = await read(engine);
    // Then
    expect(status).toMatchObject({ state: 'UNKNOWN', executions: 0 });
    await expect(engine.armJob('lost-tab')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  } finally { try { await engine.close(); } finally { await browser.close(); } }
}, 15000);

it('records retained uncertainty when shutdown follows an armed tab closure without a runtime receipt', async () => {
  // Given
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const engine = new JobEngine({ adapters: { playwright: new PlaywrightAdapter({ page }) } });
  try {
    await page.setContent('<button id="reserve" disabled>reserve</button>');
    const tab = (await engine.listTabs('playwright'))[0];
    if (!tab) throw new Error('No owned fixture tab');
    await engine.createJob({ schemaVersion: '1.0', jobId: 'shutdown-tab', name: 'closed fixture', backend: 'playwright',
      target: { tabId: tab.id, selector: '#reserve', url: 'about:blank' },
      trigger: { type: 'ELEMENT_ENABLE', selector: '#reserve' }, action: { type: 'click' }, timezone: 'UTC',
      expiresAt: Date.now() + 60000, maxExecutions: 1, verification: { timeoutMs: 1000 },
      guards: { approvedUrl: 'about:blank', allowIrreversible: false } });
    await engine.validateJob('shutdown-tab'); await engine.armJob('shutdown-tab'); await page.close();
    // When
    await engine.close();
    // Then
    expect(engine.logs().at(-1)).toMatchObject({ state: 'UNKNOWN', executions: 0 });
  } finally { try { await engine.close(); } finally { await browser.close(); } }
}, 15000);
