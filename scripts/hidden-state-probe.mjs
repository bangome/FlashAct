import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { z } from 'zod';
import { serveFixture } from '../dist/benchmark/fixture.js';
import { runtimeSource } from '../dist/runtime/index.js';

const output = new URL('../artifacts/benchmark/hidden-state-probe.json', import.meta.url);
const preserved = ['playwright-hidden.json', 'playwright-browser.json', 'aside-browser.json',
  'playwright-node.json', 'playwright-cdp.json'];
const launchOptions = { headless: false, timeout: 15000, ignoreDefaultArgs: [
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
] };
const boundsSchema = z.object({ left: z.number(), top: z.number(), width: z.number(),
  height: z.number(), windowState: z.enum(['normal', 'minimized', 'maximized', 'fullscreen']) });
const windowSchema = z.object({ windowId: z.number().int(), bounds: boundsSchema });
const snapshotSchema = z.object({ visibilityState: z.enum(['visible', 'hidden']),
  hidden: z.boolean(), nowMs: z.number(), timeOriginMs: z.number(), epochMs: z.number() });
const auditSchema = z.array(snapshotSchema);
const snapshotExpression = `(() => { const nowMs = performance.now(); return {
  visibilityState: document.visibilityState, hidden: document.hidden, nowMs,
  timeOriginMs: performance.timeOrigin, epochMs: performance.timeOrigin + nowMs }; })()`;
const report = {
  status: 'BLOCKED', command: 'node scripts/hidden-state-probe.mjs',
  startedAt: new Date().toISOString(), nodeVersion: process.version, launchOptions,
  method: 'Native minimization of only the fresh task-owned primary Chromium window; not inactive-tab control.',
  flagDisclosure: 'Listed background-bypass defaults are removed, not added; remaining Playwright defaults stay enabled.',
  runtimeSha256: createHash('sha256').update(runtimeSource()).digest('hex'),
  measurementTrials: 0, observations: [], cdpCommands: [], errors: [],
  teardown: { primaryCDP: 'not-created', secondaryCDP: 'not-created',
    context: 'not-created', browser: 'not-created', server: 'not-created' },
  restoration: { status: 'not-needed' },
  limitations: ['Experimental CDP window commands may be unsupported.',
    'This is a visibility gate only: no latency trials, timer-aging, sleep or SLA evidence.',
    'No screenshots, emulation, visibility getter overrides, user profiles or user-window enumeration.'],
};
let browser, context, fixture, primary, primaryCDP, secondaryCDP, original;
let minimizeAttempted = false;
let hiddenObserved = false;
let restoredVisible = false;
const started = performance.now();

class ProbeError extends Error {
  constructor(code, message) { super(message); this.name = 'ProbeError'; this.code = code; }
}
function recordError(phase, error) {
  report.errors.push({ phase, name: error instanceof Error ? error.name : 'NonError',
    message: error instanceof Error ? error.message : String(error) });
}
async function bounded(operation, timeoutMs = 8000) {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new ProbeError('TIMEOUT', `Exceeded ${timeoutMs} ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
async function command(session, method, params = {}) {
  const receipt = { method, params, startedAt: new Date().toISOString() };
  report.cdpCommands.push(receipt);
  try {
    const result = await bounded(() => session.send(method, params));
    receipt.result = result;
    receipt.status = 'supported';
    return result;
  } catch (error) {
    receipt.status = 'rejected-or-timeout';
    receipt.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
}
async function hashes() {
  return Object.fromEntries(await Promise.all(preserved.map(async name => [name,
    createHash('sha256').update(await readFile(new URL(`../artifacts/benchmark/${name}`, import.meta.url))).digest('hex')])));
}
async function observe(phase) {
  const raw = await command(primaryCDP, 'Runtime.evaluate', {
    expression: snapshotExpression, returnByValue: true,
  });
  if (raw.exceptionDetails) throw new ProbeError('EVALUATION', JSON.stringify(raw.exceptionDetails));
  const cdp = snapshotSchema.parse(raw.result.value);
  const playwright = snapshotSchema.parse(await bounded(() => primary.evaluate(snapshotExpression)));
  const native = z.object({ bounds: boundsSchema }).parse(
    await command(primaryCDP, 'Browser.getWindowBounds', { windowId: original.windowId }));
  const entry = { phase, cdp, playwright, nativeBounds: native.bounds,
    agree: cdp.visibilityState === playwright.visibilityState && cdp.hidden === playwright.hidden };
  report.observations.push(entry);
  return entry;
}
async function waitForVisibility(state) {
  const handle = await primary.waitForFunction(expected => document.visibilityState === expected,
    state, { polling: 100, timeout: 5000 });
  await handle.dispose();
}

try {
  report.hashManifest = { before: await hashes() };
  fixture = await serveFixture();
  report.teardown.server = 'open';
  report.fixtureUrl = fixture.url;
  browser = await chromium.launch(launchOptions);
  report.teardown.browser = 'open';
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: null, serviceWorkers: 'block' });
  report.teardown.context = 'open';
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(fixture.url).origin
    ? route.continue() : route.abort('blockedbyclient'));
  primary = await context.newPage();
  await primary.goto(fixture.url, { waitUntil: 'load', timeout: 10000 });
  await primary.evaluate(() => {
    const events = [];
    const capture = () => { const nowMs = performance.now(); events.push({
      visibilityState: document.visibilityState, hidden: document.hidden, nowMs,
      timeOriginMs: performance.timeOrigin, epochMs: performance.timeOrigin + nowMs,
    }); };
    globalThis.__flashactNativeVisibilityAudit = events;
    document.addEventListener('visibilitychange', capture);
    capture();
  });
  primaryCDP = await context.newCDPSession(primary);
  report.teardown.primaryCDP = 'attached';
  original = windowSchema.parse(await command(primaryCDP, 'Browser.getWindowForTarget'));
  report.originalWindow = original;
  // These sessions belong only to pages created in this fresh owned browser.
  const secondary = await context.newPage();
  await secondary.goto(fixture.url, { waitUntil: 'load', timeout: 10000 });
  secondaryCDP = await context.newCDPSession(secondary);
  report.teardown.secondaryCDP = 'attached';
  const secondaryWindow = windowSchema.parse(await command(secondaryCDP, 'Browser.getWindowForTarget'));
  report.ownedWindows = { primary: original.windowId, secondary: secondaryWindow.windowId,
    separateWindows: original.windowId !== secondaryWindow.windowId, secondaryBounds: secondaryWindow.bounds };
  report.browserProtocolVersion = await command(primaryCDP, 'Browser.getVersion');
  try {
    report.fullLaunchArguments = z.object({ arguments: z.array(z.string()) }).parse(
      await command(primaryCDP, 'Browser.getBrowserCommandLine')).arguments;
  } catch (error) {
    report.fullLaunchArguments = null;
    report.limitations.push(`Actual command-line disclosure unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  await bounded(() => secondaryCDP.detach());
  report.teardown.secondaryCDP = 'detached';
  secondaryCDP = undefined;
  await secondary.close();
  report.secondaryPage = 'closed-before-native-window-probe';
  await waitForVisibility('visible');
  const before = await observe('before-minimize');
  if (!before.agree || before.cdp.visibilityState !== 'visible' || before.cdp.hidden) {
    throw new ProbeError('INITIAL_STATE', 'Primary was not natively visible before minimization');
  }
  minimizeAttempted = true;
  report.restoration.status = 'pending';
  await command(primaryCDP, 'Browser.setWindowBounds', {
    windowId: original.windowId, bounds: { windowState: 'minimized' },
  });
  try { await waitForVisibility('hidden'); }
  finally {
    const after = await observe('after-minimize');
    hiddenObserved = after.agree && after.cdp.visibilityState === 'hidden' && after.cdp.hidden
      && after.nativeBounds.windowState === 'minimized';
  }
} catch (error) { recordError('probe', error); }
finally {
  if (minimizeAttempted && original && primaryCDP) {
    try {
      // State and geometry must be separate; minimized/maximized/fullscreen cannot carry geometry.
      await command(primaryCDP, 'Browser.setWindowBounds', {
        windowId: original.windowId, bounds: { windowState: 'normal' },
      });
      const { left, top, width, height, windowState } = original.bounds;
      await command(primaryCDP, 'Browser.setWindowBounds', {
        windowId: original.windowId, bounds: { left, top, width, height },
      });
      if (windowState !== 'normal') await command(primaryCDP, 'Browser.setWindowBounds', {
        windowId: original.windowId, bounds: { windowState },
      });
      await waitForVisibility('visible');
      const restored = await observe('after-restore');
      restoredVisible = restored.agree && restored.cdp.visibilityState === 'visible' && !restored.cdp.hidden;
      report.restoration = { status: restoredVisible ? 'restored' : 'failed',
        boundsMatch: Object.keys(original.bounds).every(key => original.bounds[key] === restored.nativeBounds[key]) };
    } catch (error) { report.restoration.status = 'failed'; recordError('restore', error); }
  }
  if (primary) {
    try { report.visibilityAudit = auditSchema.parse(await bounded(() => primary.evaluate(
      () => globalThis.__flashactNativeVisibilityAudit))); }
    catch (error) { recordError('audit', error); }
  }
  for (const [name, resource] of [['primaryCDP', primaryCDP], ['secondaryCDP', secondaryCDP],
    ['context', context], ['browser', browser], ['server', fixture]]) {
    if (!resource) continue;
    try {
      await bounded(() => name.endsWith('CDP') ? resource.detach() : resource.close());
      report.teardown[name] = name.endsWith('CDP') ? 'detached' : 'closed';
    } catch (error) { report.teardown[name] = 'failed'; recordError(`cleanup-${name}`, error); }
  }
  try {
    const after = await hashes();
    report.hashManifest = { ...report.hashManifest, after,
      unchanged: preserved.every(name => report.hashManifest?.before?.[name] === after[name]) };
  } catch (error) { recordError('hash-preservation', error); }
  const states = (report.visibilityAudit ?? []).map(event => event.visibilityState);
  report.transitionCounts = {
    visibleToHidden: states.filter((state, index) => state === 'hidden' && states[index - 1] === 'visible').length,
    hiddenToVisible: states.filter((state, index) => state === 'visible' && states[index - 1] === 'hidden').length,
  };
  report.status = hiddenObserved && restoredVisible && report.restoration.boundsMatch
    && report.transitionCounts.visibleToHidden > 0 && report.transitionCounts.hiddenToVisible > 0
    && report.hashManifest?.unchanged && report.errors.length === 0 ? 'VERIFIED' : 'BLOCKED';
  report.cleanupSuccess = Object.values(report.teardown).every(state => ['not-created', 'detached', 'closed'].includes(state));
  if (!report.cleanupSuccess) report.status = 'BLOCKED';
  report.elapsedMs = performance.now() - started;
  report.finishedAt = new Date().toISOString();
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, output: output.pathname,
    ownedWindows: report.ownedWindows, transitionCounts: report.transitionCounts,
    observations: report.observations, restoration: report.restoration, teardown: report.teardown,
    cleanupSuccess: report.cleanupSuccess, hashManifest: report.hashManifest, errors: report.errors }));
}
if (report.status !== 'VERIFIED') process.exitCode = 1;
