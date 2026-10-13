import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { recordedProcess, stdioMcpClient } from './service-use-process.mjs';

const exec = promisify(execFile);

export async function runPackaged({ browser, proxy, app, root, environment, repository, report }) {
  const pack = join(root, 'pack'), prefix = join(root, 'prefix'), cwd = join(root, 'unrelated');
  const cache = join(root, 'npm-cache');
  await Promise.all([pack, prefix, cwd].map(path => mkdir(path)));
  const options = { cwd: repository, env: { ...environment, npm_config_cache: cache }, maxBuffer: 1024 * 1024 };
  const packArgs = ['pack', '--json', '--pack-destination', pack];
  report.package = { packCommand: ['npm', ...packArgs], prefix, cwd, cache };
  const packed = await exec('npm', packArgs, options);
  const manifest = JSON.parse(packed.stdout)[0];
  const tarball = join(pack, manifest.filename);
  const installArgs = ['install', '--prefix', prefix, tarball, '--ignore-scripts', '--no-audit', '--no-fund'];
  report.package.installCommand = ['npm', ...installArgs];
  const installed = await exec('npm', installArgs, options);
  const packageRoot = join(prefix, 'node_modules/flashact');
  const bin = join(prefix, 'node_modules/.bin/flashact');
  const audit = join(root, 'worker-audit.jsonl');
  const env = { ...environment, FLASHACT_QA_WORKER_AUDIT: audit, FLASHACT_QA_PACKAGE_ROOT: packageRoot,
    NODE_OPTIONS: `--import=${pathToFileURL(join(repository, 'scripts/service-use-worker-audit.mjs')).href}` };
  Object.assign(report.package, { tarball, manifest, pack: packed, install: installed, packageRoot, bin });
  const endpoint = report.proxy.messages.find(value => value.event === 'ready').endpoint;
  const at = Date.now() + 5000;
  const item = app.register(`package-cli-${randomUUID()}`, { at });
  await browser.navigate(item.url);
  const record = {};
  report.services.push(record);
  const home = join(root, 'package-cli-home');
  const cli = recordedProcess(bin, ['schedule', '--endpoint', endpoint, '--tab', browser.targetId,
    '--url', item.url, '--approved-url', item.url, '--selector', item.selector, '--action', 'click',
    '--at', new Date(at).toISOString(), '--verify-selector', item.ack],
  { ...env, FLASHACT_HOME: home }, record, cwd);
  try {
    const result = await cli.waitFor(value => value.state === 'VERIFIED', 'installed bin verification');
    const receipt = await item.receipt;
    assert.equal(result.executions, 1);
    assert.equal(result.execution.scheduler, 'host-assisted');
    assert(receipt.accepted && !receipt.early && !receipt.duplicate);
    await cli.stop('SIGINT');
    assert.equal(record.exit.code, 0);
    await assert.rejects(lstat(join(home, 'engine.json')), { code: 'ENOENT' });
    report.package.cli = { result, receipt };
  } finally { await cli.stop(); }
  const disabled = app.register(`package-mcp-${randomUUID()}`, { enabled: false });
  await browser.navigate(disabled.url);
  const mcpRecord = {};
  report.services.push(mcpRecord);
  const mcpHome = join(root, 'package-mcp-home');
  const process = recordedProcess(bin, ['mcp', '--endpoint', endpoint],
    { ...env, FLASHACT_HOME: mcpHome }, mcpRecord, cwd);
  const client = stdioMcpClient(process);
  try {
    await client.initialize();
    const mcpAt = Date.now() + 3000;
    const accepted = app.register(`package-mcp-verify-${randomUUID()}`, { at: mcpAt });
    await browser.navigate(accepted.url);
    await browser.evaluate(`(() => {
      globalThis.__packageAck = new Promise(resolve => {
        const observer = new MutationObserver(() => {
          if (document.querySelector(${JSON.stringify(accepted.ack)})) { observer.disconnect(); resolve(true); }
        });
        observer.observe(document.getElementById("result"), { childList: true });
      });
    })()`);
    const verifyPlan = { schemaVersion: '1.0', jobId: accepted.token, name: 'installed verification', backend: 'playwright',
      target: { tabId: browser.targetId, url: accepted.url, selector: accepted.selector },
      trigger: { type: 'SCHEDULED', at: mcpAt }, action: { type: 'click' }, timezone: 'UTC',
      expiresAt: mcpAt + 60000, maxExecutions: 1, verification: { selector: accepted.ack, timeoutMs: 5000 },
      guards: { approvedUrl: accepted.url, allowIrreversible: false } };
    await client.tool('flashact_create_job', { plan: verifyPlan });
    await client.tool('flashact_validate_job', { jobId: verifyPlan.jobId });
    await client.tool('flashact_arm_job', { jobId: verifyPlan.jobId });
    await browser.evaluate('globalThis.__packageAck');
    const verified = await client.tool('flashact_get_result', { jobId: verifyPlan.jobId });
    assert.equal(verified.state, 'VERIFIED');
    assert.equal(verified.executions, 1);
    assert.equal(verified.execution.scheduler, 'host-assisted');
    const mcpReceipt = await accepted.receipt;
    assert(mcpReceipt.accepted && !mcpReceipt.early && !mcpReceipt.duplicate);
    assert.equal(accepted.receipts.length, 1);
    report.package.mcpVerified = { plan: verifyPlan, result: verified, receipt: mcpReceipt };
    await browser.navigate(disabled.url);
    const plan = { schemaVersion: '1.0', jobId: disabled.token, name: 'installed cancel', backend: 'playwright',
      target: { tabId: browser.targetId, url: disabled.url, selector: disabled.selector },
      trigger: { type: 'ELEMENT_ENABLE', selector: disabled.selector }, action: { type: 'click' },
      timezone: 'UTC', expiresAt: Date.now() + 60000, maxExecutions: 1,
      verification: { timeoutMs: 5000 },
      guards: { approvedUrl: disabled.url, allowIrreversible: false } };
    await client.tool('flashact_create_job', { plan });
    await client.tool('flashact_validate_job', { jobId: plan.jobId });
    await client.tool('flashact_arm_job', { jobId: plan.jobId });
    const result = await client.tool('flashact_cancel_job', { jobId: plan.jobId });
    assert.equal(result.state, 'CANCELLED');
    assert.equal(result.executions, 0);
    process.end();
    await process.exited;
    assert.equal(mcpRecord.exit.code, 0);
    const shutdown = mcpRecord.stderr.trim().split('\n').map(line => JSON.parse(line)).find(value => value.event === 'shutdown');
    assert(shutdown?.cleanup);
    await assert.rejects(lstat(join(mcpHome, 'engine.json')), { code: 'ENOENT' });
    assert.equal(disabled.receipts.length, 0);
    report.package.mcp = { plan, result, shutdown };
  } finally { await process.stop(); }
  report.package.workers = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert(report.package.workers.length >= 2);
  const canonicalRoot = pathToFileURL(`${await realpath(packageRoot)}/`).href;
  assert(report.package.workers.every(value => value.canonical.startsWith(canonicalRoot)));
}
