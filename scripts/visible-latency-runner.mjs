import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveFixture } from '../dist/benchmark/fixture.js';
import { runtimeSource } from '../dist/runtime/index.js';
import { visibleTrial } from './visible-latency-page.mjs';
import { OwnedRun } from './visible-latency-owned.mjs';
import { createReport, errorText, finishReport, hashes, launchOptions, preserved, reserveOutput } from './visible-latency-report.mjs';

// The adapter seam supplies deferred native acquisition / persistence in tests, not a second runtime.
export async function runVisible(options = {}, adapters = {}) {
  const scope = new OwnedRun({ drainMs: options.drainMs, diagnostic: adapters.diagnostic });
  const source = runtimeSource();
  const report = createReport(options, source);
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => scope.stop(signal)]));
  const signals = adapters.signals ?? process;
  for (const [signal, handler] of handlers) signals.on(signal, handler);
  const watchdog = scope.timer(() => scope.stop('watchdog'), report.watchdogMs);
  let output;
  const write = async snapshot => {
    if (adapters.writeReport) await adapters.writeReport(snapshot, output.write);
    else await output.write(snapshot);
  };
  async function produce() {
    // Reservation is retained even when stop arrives during open; it is not a browser resource.
    await scope.stage('reserve-output', async () => { output = await reserveOutput(options.output); });
    report.childReportPath = output.path;
    report.hashManifest = { before: await scope.stage('hashes-before', hashes) };
    const probe = await scope.stage('probe', async () => JSON.parse(await readFile(
      new URL('../artifacts/benchmark/hidden-state-probe.json', import.meta.url), 'utf8')));
    report.hiddenRows.nativeGate = probe.status;
    report.runtimeMatchesProbe = probe.runtimeSha256 === report.runtimeSha256;
    if (probe.status !== 'BLOCKED' || !report.runtimeMatchesProbe) throw new Error('Probe/runtime gate mismatch');
    const fixture = await scope.acquire('fixture', adapters.serveFixture ?? serveFixture, resource => resource.close());
    report.fixtureUrl = fixture.url;
    const browser = await scope.acquire('browser', () => (adapters.launch ?? (options => chromium.launch(options)))(launchOptions),
      resource => resource.close({ reason: 'visible benchmark drain' }));
    report.browserVersion = browser.version();
    const context = await scope.acquire('context', () => browser.newContext({ viewport: null, serviceWorkers: 'block' }),
      resource => resource.close({ reason: 'visible benchmark drain' }));
    await scope.stage('route', () => context.route('**/*', route => new URL(route.request().url()).origin === new URL(fixture.url).origin
      ? route.continue() : route.abort('blockedbyclient')));
    await scope.stage('init', () => context.addInitScript(() => {
      globalThis.__visibleAudit = [];
      const capture = () => globalThis.__visibleAudit.push({ epochMs: performance.timeOrigin + performance.now(),
        wallMs: Date.now(), visibilityState: document.visibilityState, hidden: document.hidden });
      document.addEventListener('visibilitychange', capture); capture();
    }));
    const page = await scope.acquire('page', () => context.newPage(),
      resource => resource.close({ runBeforeUnload: false, reason: 'visible benchmark drain' }));
    await scope.stage('goto', () => page.goto(fixture.url, { waitUntil: 'load', timeout: 10000 }));
    const cdp = await scope.acquire('cdp', () => context.newCDPSession(page), resource => resource.detach());
    report.nativeWindowBefore = await scope.stage('window-before', () => cdp.send('Browser.getWindowForTarget'));
    report.browserProtocol = await scope.stage('version', () => cdp.send('Browser.getVersion'));
    try { report.fullLaunchArguments = (await scope.stage('argv', () => cdp.send('Browser.getBrowserCommandLine'))).arguments; }
    catch (error) { scope.check(); report.commandLineDisclosureError = errorText(error); }
    await scope.stage('runtime', () => page.evaluate(source));
    for (const cell of report.matrix) for (let index = 0; index < cell.trials; index++) {
      scope.check();
      const trial = { scenario: cell.scenario, horizonMs: cell.horizonMs, trialIndex: index, jobId: `visible-${randomUUID()}` };
      report.activeTrial = trial;
      let observed;
      try {
        const row = await scope.stage('trial', async () => {
          observed = await page.evaluate(`(${visibleTrial.toString()})(${JSON.stringify(trial)})`);
          return observed;
        }, cell.horizonMs + 5000);
        scope.check();
        report.samples.push(row);
        report.completedVisibleTrials++;
        report.activeTrial = null;
        await scope.stage('checkpoint', () => write(structuredClone(report)));
        if (!row.validVisibility) throw new Error('Hidden transition invalidated visible experiment; no replacement');
      } catch (error) {
        if (report.activeTrial) {
          report.samples.push({ ...trial, ...observed, success: false, aborted: scope.controller.signal.aborted,
            clicks: observed?.clicks ?? [], evidence: observed ? 'returned-after-stop' : 'no-host-observation',
            error: errorText(error) });
          report.activeTrial = null;
        }
        throw error;
      }
    }
    report.nativeWindowAfter = await scope.stage('window-after', () => cdp.send('Browser.getWindowForTarget'));
    report.visibilityAudit = await scope.stage('audit', () => page.evaluate(() => globalThis.__visibleAudit));
  }
  try {
    // Retain the producer: stop closes owned resources, it never substitutes for this await.
    await scope.track('producer', produce());
  } catch (error) {
    report.errors.push({ phase: 'run', message: errorText(error) });
    scope.stop(errorText(error));
  } finally {
    await scope.drain();
    scope.clear(watchdog);
    for (const [signal, handler] of handlers) signals.removeListener(signal, handler);
  }
  try {
    const after = await hashes();
    if (output) report.childReportPath = output.path;
    report.hashManifest = { ...report.hashManifest, after,
      unchanged: preserved.every(path => report.hashManifest?.before?.[path] === after[path]) };
    const final = finishReport(report, scope.snapshot());
    if (!output) throw new Error(report.errors[0]?.message ?? 'Output reservation failed');
    await write(final);
    await output.close();
    output = null;
    (adapters.summary ?? (value => console.log(JSON.stringify(value))))({ status: final.status,
      output: final.childReportPath, summary: final.summary, teardown: final.teardown,
      cleanupSuccess: final.cleanupSuccess, stopReason: final.lifecycle.stopReason,
      preserved: final.hashManifest.unchanged, errors: final.errors });
    return final;
  } finally { if (output) await output.close(); }
}
