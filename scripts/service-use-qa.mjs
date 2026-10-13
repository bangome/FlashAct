import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServiceFixture } from './service-use-fixture.mjs';
import { openServiceBrowser } from './service-use-browser.mjs';
import { recordedProcess, stdioMcpClient } from './service-use-process.mjs';
import { capturedPlans } from './service-use-proxy.mjs';
import { runCompositeCases } from './service-use-composites.mjs';
import { runLifecycle } from './service-use-lifecycle.mjs';
import { runPackaged } from './service-use-packaged.mjs';
import { runtimeSource } from '../dist/runtime/index.js';
import { parsePlan } from '../dist/core/schema.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const input = Object.fromEntries(Array.from({ length: process.argv.slice(2).length / 2 },
  (_, index) => [process.argv[2 + index * 2], process.argv[3 + index * 2]]));
const scenario = input['--scenario'];
assert(['cli-hidden', 'mcp-hidden', 'lifecycle', 'packaged'].includes(scenario), 'Choose cli-hidden, mcp-hidden, lifecycle or packaged');
const samples = Number(input['--samples'] ?? 20);
assert(Number.isSafeInteger(samples) && samples > 0);
const evidence = resolve(input['--evidence-dir'] ?? '.omo/evidence/service-use-20261013');
await mkdir(evidence, { recursive: true });
const id = randomUUID();
const qaRoot = await mkdtemp(join(tmpdir(), `service-use-${scenario}-`));
const environment = { ...process.env, TMPDIR: qaRoot, NODE_COMPILE_CACHE: join(qaRoot, 'node-cache'),
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(qaRoot, 'bun-cache') };
Object.assign(process.env, environment);
const reportPath = join(evidence, `${scenario}-${id}.json`);
const reportFile = await open(reportPath, 'wx', 0o600);
const report = { id, scenario, samplesRequested: samples, qaRoot, command: process.argv,
  startedAt: new Date().toISOString(), status: 'INCOMPLETE', rows: [], proxy: {}, services: [],
  scope: 'Authored localhost acceptance, empirical native-hidden sample; no arbitrary-site or universal SLA claim' };
const app = await createServiceFixture();
const gateCase = app.register(`gate-${id}`);
let browser, proxy, mcp, currentCli;

async function armAck(item) {
  const before = await browser.evaluate(`(() => {
    const selector = ${JSON.stringify(item.ack)};
    const present = Boolean(document.querySelector(selector));
    globalThis.__serviceAck = new Promise(resolve => {
      const observer = new MutationObserver(() => {
        const output = document.querySelector(selector);
        if (output) { observer.disconnect(); resolve(output.dataset.ack); }
      });
      observer.observe(document.getElementById("result"), { childList: true, subtree: true });
    });
    return { present, hidden: document.hidden, url: location.href };
  })()`);
  assert(!before.present && before.hidden && before.url === item.url);
}

function summary(rows) {
  const sorted = rows.map(row => row.latencyMs).sort((a, b) => a - b);
  return { count: sorted.length, meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    medianMs: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1), over50Ms: sorted.filter(value => value > 50).length };
}

async function screenshot() {
  const { loadOmowright } = await import('/Users/bogyung/.omo/binary-runtime/5.1.32/plugin/skills/browser/scripts/omowright.mjs');
  const { omowright } = await loadOmowright();
  const connection = await omowright.connect(`http://127.0.0.1:${new URL(browser.endpoint).port}`, { storageRoot: evidence });
  try {
    const page = await connection.attachPage(browser.targetId);
    report.actionLog = omowright.compactSnapshot(await page.snapshot());
    report.screenshot = join(evidence, `${scenario}-${id}.png`);
    await page.screenshot({ path: report.screenshot });
  } finally { await connection.close(); }
}

try {
  browser = await openServiceBrowser(qaRoot, gateCase.url, report);
  await browser.gate();
  await browser.minimize();
  proxy = recordedProcess(environment.FLASHACT_QA_BUN ?? 'bun',
    [join(repository, 'scripts/service-use-proxy.mjs'), browser.endpoint], environment, report.proxy);
  const proxyReady = await proxy.waitFor(value => value.event === 'ready', 'actual CDP proxy');
  let client;
  if (scenario === 'mcp-hidden') {
    const service = {};
    report.services.push(service);
    mcp = recordedProcess(process.execPath, [join(repository, 'dist/cli/index.js'), 'mcp', '--endpoint', proxyReady.endpoint],
      { ...environment, FLASHACT_HOME: join(qaRoot, 'mcp-home') }, service);
    client = stdioMcpClient(mcp);
    await client.initialize();
    report.capabilities = await client.tool('flashact_list_backends', {});
    assert.equal(report.capabilities.defaultScheduling, 'auto');
    const tabs = await client.tool('flashact_list_tabs', { backend: 'playwright' });
    assert(tabs.some(tab => tab.id === browser.targetId));
  }
  if (scenario === 'lifecycle') {
    await runLifecycle({ browser, proxy, app, root: qaRoot, environment,
      cliPath: join(repository, 'dist/cli/index.js'), report });
  } else if (scenario === 'packaged') {
    await runPackaged({ browser, proxy, app, root: qaRoot, environment, repository, report });
  } else {
    for (let index = 0; index < samples; index++) {
      const token = `${id}-${index}`;
      const at = Date.now() + 5000;
      const item = app.register(token, { at });
      report.activeCase = { index, token, requestedAt: at, url: item.url };
      await browser.navigate(item.url);
      await armAck(item);
      const before = await browser.observe(`before-${index}`);
      assert(before.hidden && before.bounds.windowState === 'minimized');
      const protocolStart = report.proxy.messages.length;
      let status, plan;
      if (scenario === 'cli-hidden') {
        const service = {};
        report.services.push(service);
        const args = [join(repository, 'dist/cli/index.js'), 'schedule', '--endpoint', proxyReady.endpoint,
          '--tab', browser.targetId, '--url', item.url, '--approved-url', item.url,
          '--at', new Date(at).toISOString(), '--selector', item.selector, '--action', 'click',
          '--verify-selector', item.ack, '--verify-timeout-ms', '5000'];
        currentCli = recordedProcess(process.execPath, args,
          { ...environment, FLASHACT_HOME: join(qaRoot, `cli-${index}`) }, service);
        status = await currentCli.waitFor(value => value.state === 'VERIFIED', 'actual CLI server acknowledgement');
        const plans = capturedPlans(report.proxy.messages.slice(protocolStart).filter(value => value.event === 'protocol'),
          runtimeSource(), parsePlan);
        assert.equal(plans.length, 1);
        plan = plans[0];
        await currentCli.stop();
        assert.equal(service.exit.code, 0);
        currentCli = undefined;
      } else {
        plan = parsePlan({ schemaVersion: '1.0', jobId: `mcp-${token}`, name: 'actual MCP acceptance', backend: 'playwright',
          target: { tabId: browser.targetId, selector: item.selector, url: item.url },
          trigger: { type: 'SCHEDULED', at }, action: { type: 'click' }, timezone: 'UTC',
          expiresAt: at + 60000, maxExecutions: 1, verification: { selector: item.ack, timeoutMs: 5000 },
          guards: { approvedUrl: item.url, allowIrreversible: false } });
        await client.tool('flashact_create_job', { plan });
        await client.tool('flashact_validate_job', { jobId: plan.jobId });
        await client.tool('flashact_arm_job', { jobId: plan.jobId });
        await browser.evaluate('globalThis.__serviceAck');
        status = await client.tool('flashact_get_status', { jobId: plan.jobId });
        assert.equal(status.state, 'VERIFIED');
        assert.deepEqual(await client.tool('flashact_get_result', { jobId: plan.jobId }), status);
      }
      const receipt = await item.receipt;
      const snapshot = await browser.evaluate('globalThis.__serviceFixture.snapshot()');
      const after = await browser.observe(`after-${index}`);
      assert(receipt.accepted && !receipt.early && !receipt.duplicate && receipt.hidden);
      assert.equal(item.receipts.length, 1);
      assert.equal(snapshot.clicks.length, 1);
      assert(snapshot.audit.every(event => event.trusted && event.hidden));
      assert(after.hidden && after.bounds.windowState === 'minimized');
      assert.equal(status.executions, 1);
      assert.equal(status.execution.scheduler, 'host-assisted');
      assert.equal(status.execution.transport, 'owned-worker');
      assert.equal(status.jobId, plan.jobId);
      assert.equal(plan.trigger.at, at);
      const row = { index, token, plan, status, receipt, before, after, snapshot,
        latencyMs: receipt.clickEpochMs - at,
        wakeRequests: report.proxy.messages.slice(protocolStart).filter(value => value.direction === 'send' && value.wake) };
      report.rows.push(row);
      report.activeCase = null;
      console.log(`CASE ${JSON.stringify({ index, jobId: plan.jobId, latencyMs: row.latencyMs })}`);
    }
    report.summary = summary(report.rows);
    assert.equal(report.rows.length, samples);
    assert.equal(new Set(report.rows.map(row => row.plan.jobId)).size, samples);
    assert.equal(app.attempts.length, samples);
    assert(report.summary.meanMs <= 50, 'All samples remain in the mean, including outliers');
    if (client) {
      await runCompositeCases(client, browser, app, report);
      assert.equal(report.composites.length, 3);
    }
  }
  await browser.restore();
  await screenshot();
  report.status = scenario === 'lifecycle' ? 'LIFECYCLE_PASS'
    : scenario === 'packaged' ? 'PACKAGE_PASS'
    : samples === 20 ? 'HIDDEN_20_PASS' : 'DIAGNOSTIC_SAMPLE_PASS';
} catch (error) { report.status = 'FAILED'; report.error = error.message; process.exitCode = 1; }
finally {
  const cleanup = [];
  const clean = async (name, operation) => {
    try { await operation(); cleanup.push(`${name}-joined`); }
    catch (error) {
      report.cleanupErrors ??= [];
      report.cleanupErrors.push({ name, error: error.message });
      process.exitCode = 1;
    }
  };
  if (currentCli) await clean('cli', () => currentCli.stop());
  if (mcp) await clean('mcp', async () => {
    mcp.end();
    const deadline = setTimeout(() => { void mcp.stop(); }, 10000);
    try { await mcp.exited; }
    finally { clearTimeout(deadline); }
  });
  if (proxy) await clean('proxy', async () => {
    proxy.send({ command: 'close' });
    await proxy.waitFor(value => value.event === 'closed', 'actual proxy shutdown');
    await proxy.exited;
  });
  await clean('browser', () => browser?.close());
  await clean('fixture', async () => { report.fixtureCleanup = await app.close(); });
  report.ledger = app.attempts;
  report.cleanup = cleanup;
  if (report.cleanupErrors?.length) report.status = 'FAILED';
  await reportFile.writeFile(JSON.stringify(report, null, 2));
  await reportFile.close();
}
console.log(JSON.stringify({ status: report.status, reportPath, qaRoot, summary: report.summary, cleanup: report.cleanup,
  browserRemoved: report.browser?.removed, error: report.error, cleanupErrors: report.cleanupErrors }));
