import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { z } from 'zod';
import { runtimeSource } from '../dist/runtime/index.js';
import { serveFixture } from '../dist/benchmark/fixture.js';
import { batchExpression } from '../dist/benchmark/page-batch.js';
import { batchSchema } from '../dist/benchmark/browser.js';
import { summarize } from '../dist/benchmark/statistics.js';

// Run from the project root: serveFixture resolves examples/local.html from CWD.
const output = 'artifacts/benchmark/playwright-hidden.json';
const screenshot = 'artifacts/benchmark/playwright-hidden.png';
const launchOptions = {
  headless: false,
  timeout: 15000,
  ignoreDefaultArgs: [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
};
const source = runtimeSource();
const eventSchema = z.object({ state: z.enum(['visible', 'hidden']), epochMs: z.number() });
const auditSchema = z.object({ visibility: z.enum(['visible', 'hidden']), events: z.array(eventSchema) });
const report = {
  status: 'not-verified',
  command: 'node scripts/hidden-tab-benchmark.mjs',
  startedAt: new Date().toISOString(),
  deadlineMs: 120000,
  measurementBudgetMs: 100000,
  backend: 'playwright',
  launchOptions,
  flagDisclosure: 'The three listed default flags are removed, not added. All other Playwright defaults remain; this is not a stock consumer Chromium configuration.',
  runtimeSha256: createHash('sha256').update(source).digest('hex'),
  implementation: 'Compiled runtimeSource(), batchExpression()/pageBatch(), batchSchema and summarize() from dist; no host IPC in measured click path.',
  visibilityMethod: 'Native document.visibilityState; second task-owned page brought to front. No visibility override or emulation.',
  batches: [],
  visibilityAudit: null,
  screenshot: null,
  teardown: { context: 'not-created', browser: 'not-created', server: 'not-created' },
  limitations: [
    '20 independent serialized jobs per case; nearest-rank p99 is the sample maximum, not a population guarantee.',
    'Background timers may be throttled; scheduled target is only 12 ms ahead and job expiry is 3000 ms, unchanged from pageBatch.',
    'Reactive enable happens in the same page task after arm; this is not latency from a delayed external event.',
    'Actual HTMLElement synthetic local clicks only; VERIFIED does not imply trusted input or server acceptance.',
    'Existing normal/Aside/high-CPU reports are untouched; prior Aside high-CPU p99 53.4 ms missed 50 ms. Hidden p99 may be worse.',
    'pageBatch cancellation calls are reported, not instrumented timer/observer leak counts. Context closure destroys the owned document/runtime.',
    'No five-minute intensive-throttling aging or OS sleep scenario is measured.',
  ],
  errors: [],
};
let browser;
let context;
let fixture;
let page;
const started = performance.now();

class BenchmarkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BenchmarkError';
    this.code = code;
  }
}

async function bounded(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new BenchmarkError('TIMEOUT', `Exceeded ${timeoutMs} ms budget`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function measure() {
  fixture = await serveFixture();
  report.teardown.server = 'open';
  report.fixtureUrl = fixture.url;
  browser = await chromium.launch(launchOptions);
  report.teardown.browser = 'open';
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1000, height: 700 }, serviceWorkers: 'block' });
  report.teardown.context = 'open';
  // Only the owned loopback fixture can be requested from these pages.
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(fixture.url).origin
    ? route.continue() : route.abort('blockedbyclient'));
  page = await context.newPage();
  await page.goto(fixture.url, { waitUntil: 'load', timeout: 10000 });
  await page.evaluate(source);
  const foreground = await context.newPage();
  await foreground.goto(fixture.url, { waitUntil: 'load', timeout: 10000 });
  await foreground.bringToFront();
  report.visibilityAfterBringToFront = await page.evaluate(() => document.visibilityState);
  await page.waitForFunction(() => document.visibilityState === 'hidden', undefined, { polling: 100, timeout: 5000 });
  await page.evaluate(() => {
    const events = [{ state: document.visibilityState, epochMs: performance.timeOrigin + performance.now() }];
    document.addEventListener('visibilitychange', () => {
      events.push({ state: document.visibilityState, epochMs: performance.timeOrigin + performance.now() });
    });
    globalThis.__flashactHiddenAudit = events;
  });
  for (const scenario of ['background', 'reactive']) {
    // The visibility check and serialized pageBatch call start in the same page task.
    const expression = batchExpression({ backend: 'playwright', iterations: 20, scenario });
    const wrapped = `(async () => {
      const before = document.visibilityState;
      if (before !== 'hidden') throw new Error('Native visibility was not hidden before batch');
      const raw = await ${expression};
      return {before, raw, after: document.visibilityState};
    })()`;
    const envelope = z.object({ before: z.literal('hidden'), raw: z.string(), after: z.enum(['visible', 'hidden']) })
      .parse(await page.evaluate(wrapped));
    const batch = batchSchema.parse(JSON.parse(envelope.raw));
    report.batches.push({ scenario, visibilityBefore: envelope.before, visibilityAfter: envelope.after,
      summary: summarize(batch.samples), ...batch });
    console.log(JSON.stringify({ scenario, visibilityBefore: envelope.before, visibility: batch.visibility,
      summary: summarize(batch.samples), teardown: batch.teardown }));
    if (envelope.after !== 'hidden' || batch.visibility !== 'hidden') {
      throw new BenchmarkError('VISIBILITY', 'Native visibility changed during measurement');
    }
  }
  report.visibilityAudit = auditSchema.parse(await page.evaluate(() => ({
    visibility: document.visibilityState, events: globalThis.__flashactHiddenAudit,
  })));
  if (report.visibilityAudit.visibility !== 'hidden' || report.visibilityAudit.events.some(event => event.state !== 'hidden')) {
    throw new BenchmarkError('VISIBILITY', 'Visibility audit does not establish continuous hidden measurement');
  }
  // Capture the fixture only after measurement; screenshot rendering is not in the timing path.
  const image = await page.screenshot({ type: 'png', timeout: 5000, animations: 'allow' });
  await writeFile(screenshot, image);
  report.screenshot = { path: screenshot, phase: 'after-measurement', provesVisibility: false };
  report.status = report.batches.every(batch => batch.samples.length === 20 && batch.summary.failures === 0
    && batch.summary.duplicates === 0 && batch.summary.earlyBeyondUncertainty === 0 && batch.summary.wallClockEarly === 0)
    ? 'measured' : 'measured-with-failures';
}

try {
  await bounded(measure, report.measurementBudgetMs);
} catch (error) {
  if (!(error instanceof Error)) throw error;
  report.errors.push({ phase: 'measurement', name: error.name, message: error.message });
  report.status = 'not-verified';
} finally {
  // A blocked run still retains native visibility and an owned fixture image.
  if (page && report.screenshot === null && performance.now() - started < 100000) {
    try {
      await bounded(async () => {
        report.visibilityAtFailure = await page.evaluate(() => document.visibilityState);
        const image = await page.screenshot({ type: 'png', timeout: 3000, animations: 'allow' });
        await writeFile(screenshot, image);
        report.screenshot = { path: screenshot, phase: 'blocked-run', provesVisibility: false };
      }, 5000);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      report.errors.push({ phase: 'blocked-evidence', name: error.name, message: error.message });
    }
  }
  // A rejected/timeout evaluation is interrupted by closing its owned context/browser.
  for (const [name, resource] of [['context', context], ['browser', browser], ['server', fixture]]) {
    if (!resource) continue;
    try {
      await bounded(() => resource.close(), 4000);
      report.teardown[name] = 'closed';
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      report.teardown[name] = 'close-failed';
      report.errors.push({ phase: `close-${name}`, name: error.name, message: error.message });
      report.status = 'not-verified';
    }
  }
  report.elapsedMs = performance.now() - started;
  report.finishedAt = new Date().toISOString();
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, output, screenshot: report.screenshot,
    elapsedMs: report.elapsedMs, teardown: report.teardown, errors: report.errors }));
}
if (report.status !== 'measured') process.exitCode = 1;
