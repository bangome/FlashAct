import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { NodeScheduler } from '../dist/core/scheduler/node-scheduler.js';
import { recordedProcess, stdioMcpClient } from './service-use-process.mjs';

const exec = promisify(execFile);
const scheduler = new NodeScheduler();
const boundary = at => new Promise(resolve => scheduler.schedule(at, resolve));

function planFor(item, browser, at, expiresAt) {
  return { schemaVersion: '1.0', jobId: item.token, name: item.token, backend: 'playwright',
    target: { tabId: browser.targetId, selector: item.selector, url: item.url },
    trigger: { type: 'SCHEDULED', at }, action: { type: 'click' }, timezone: 'UTC',
    expiresAt, maxExecutions: 1, verification: { selector: item.ack, timeoutMs: 5000 },
    guards: { approvedUrl: item.url, allowIrreversible: false } };
}

async function refused(operation) {
  let rejection;
  try { await operation(); }
  catch (error) { rejection = error.message; }
  assert(rejection, 'Actual tool must reject this request');
  return rejection;
}

export async function runLifecycle({ browser, proxy, app, root, environment, cliPath, report }) {
  report.lifecycle = [];
  const endpoint = report.proxy.messages.find(value => value.event === 'ready').endpoint;
  const start = async label => {
    const record = { label };
    report.services.push(record);
    const home = join(root, label);
    const process = recordedProcess(globalThis.process.execPath, [cliPath, 'mcp', '--endpoint', endpoint],
      { ...environment, FLASHACT_HOME: home }, record);
    const client = stdioMcpClient(process);
    await client.initialize();
    return { process, client, record, home };
  };
  const finish = async (service, signal) => {
    if (signal) await service.process.stop(signal);
    else {
      service.process.end();
      const timer = setTimeout(() => { void service.process.stop(); }, 10000);
      try { await service.process.exited; } finally { clearTimeout(timer); }
    }
    assert.equal(service.record.exit.code, 0);
    const shutdown = service.record.stderr.trim().split('\n').map(line => JSON.parse(line))
      .find(value => value.event === 'shutdown');
    assert(shutdown?.cleanup);
    await assert.rejects(lstat(join(service.home, 'engine.json')), { code: 'ENOENT' });
    return shutdown;
  };

  const guards = await start('lifecycle-guards');
  try {
    for (const kind of ['cancel', 'expiry', 'malformed', 'url', 'unique', 'irreversible']) {
      const now = Date.now(), at = now + 1500, expiry = at + 1200;
      const item = app.register(`lifecycle-${kind}-${randomUUID()}`, {
        at, enabled: kind !== 'expiry', irreversible: kind === 'irreversible',
      });
      await browser.navigate(item.url);
      const plan = planFor(item, browser, at, expiry);
      if (kind === 'expiry') plan.trigger = { type: 'AND', conditions: [
        { type: 'SCHEDULED', at }, { type: 'ELEMENT_ENABLE', selector: item.selector },
      ] };
      const row = { kind, plan };
      if (kind === 'malformed') {
        row.rejection = await refused(() => guards.client.tool('flashact_create_job', { plan: { ...plan, maxExecutions: 2 } }));
      } else {
        if (kind === 'url') {
          plan.target.url += '?not-approved-document';
          plan.guards.approvedUrl = plan.target.url;
        }
        if (kind === 'unique') await browser.evaluate('document.getElementById("target").append(document.getElementById("action").cloneNode(true))');
        await guards.client.tool('flashact_create_job', { plan });
        if (['url', 'unique', 'irreversible'].includes(kind)) {
          row.rejection = await refused(() => guards.client.tool('flashact_validate_job', { jobId: plan.jobId }));
        } else {
          await guards.client.tool('flashact_validate_job', { jobId: plan.jobId });
          await guards.client.tool('flashact_arm_job', { jobId: plan.jobId });
          row.repeatedArm = await refused(() => guards.client.tool('flashact_arm_job', { jobId: plan.jobId }));
          if (kind === 'cancel') {
            row.result = await guards.client.tool('flashact_cancel_job', { jobId: plan.jobId });
            assert.equal(row.result.state, 'CANCELLED');
          }
          // Time is the behavior here: observe through the explicit expiry boundary.
          await boundary(expiry + 200);
          if (kind === 'expiry') {
            await browser.evaluate('globalThis.__serviceFixture.enable()');
            row.result = await guards.client.tool('flashact_get_result', { jobId: plan.jobId });
            assert.equal(row.result.state, 'EXPIRED');
          }
        }
      }
      row.snapshot = await browser.evaluate('globalThis.__serviceFixture.snapshot()');
      assert.equal(row.snapshot.clicks.length, 0);
      assert.equal(item.receipts.length, 0);
      report.lifecycle.push(row);
    }
    const at = Date.now() + 3000;
    const item = app.register(`reentrant-${randomUUID()}`, { at });
    await browser.navigate(item.url);
    const plan = planFor(item, browser, at, at + 15000);
    await browser.evaluate(`(() => {
      const id = ${JSON.stringify(plan.jobId)};
      globalThis.__reentrant = [];
      document.getElementById("action").addEventListener("click", () => {
        globalThis.__reentrant.push(globalThis.__flashactRuntime.wake(id));
        globalThis.__reentrant.push(globalThis.__flashactRuntime.arm(id));
        globalThis.__reentrant.push(globalThis.__flashactRuntime.wake(id));
      });
      globalThis.__reentrantAck = new Promise(resolve => {
        const observer = new MutationObserver(() => {
          if (document.querySelector(${JSON.stringify(item.ack)})) { observer.disconnect(); resolve(true); }
        });
        observer.observe(document.getElementById("result"), { childList: true });
      });
    })()`);
    await guards.client.tool('flashact_create_job', { plan });
    await guards.client.tool('flashact_validate_job', { jobId: plan.jobId });
    await guards.client.tool('flashact_arm_job', { jobId: plan.jobId });
    const early = await browser.evaluate(`globalThis.__flashactRuntime.wake(${JSON.stringify(plan.jobId)})`);
    assert.equal(early.executions, 0);
    await browser.evaluate('globalThis.__reentrantAck');
    const result = await guards.client.tool('flashact_get_result', { jobId: plan.jobId });
    const reentrant = await browser.evaluate('globalThis.__reentrant');
    const terminal = await browser.evaluate(`globalThis.__flashactRuntime.wake(${JSON.stringify(plan.jobId)})`);
    assert.equal(result.state, 'VERIFIED');
    assert.equal(result.executions, 1);
    assert.equal(reentrant.length, 3);
    assert(reentrant.every(status => status.executions === 1 && status.state === 'DISPATCHED'));
    assert.equal(terminal.executions, 1);
    assert.equal(item.receipts.length, 1);
    const receipt = await item.receipt;
    assert(receipt.accepted && !receipt.early && !receipt.duplicate);
    report.lifecycle.push({ kind: 'early-reentrant-terminal-wake', plan, early, reentrant, terminal, result, receipt });
  } finally { report.guardShutdown = await finish(guards); }

  for (const observed of [1, 0]) {
    const protocolStart = report.proxy.messages.length;
    const service = await start(`lost-${observed}`);
    try {
      await service.client.tool('flashact_list_tabs', { backend: 'playwright' });
      const peer = report.proxy.messages.slice(protocolStart).find(value => value.direction === 'send')?.peer;
      assert(peer !== undefined);
      const mode = observed ? 'all-replies-after-wake' : 'all-observations-after-wake';
      proxy.send({ command: 'mode', value: mode });
      await proxy.waitFor(value => value.event === 'mode' && value.value === mode, 'deliberate actual reply hold');
      const at = Date.now() + 2000;
      const item = app.register(`lost-${observed}-${randomUUID()}`, { at });
      await browser.navigate(item.url);
      const plan = planFor(item, browser, at, at + 15000);
      const withheld = proxy.waitFor(value => value.direction === 'withheld' && value.peer === peer, 'actual held SDK reply');
      const exitedTransport = proxy.waitFor(value => value.event === 'peer-closed' && value.peer === peer, 'actual owned SDK transport exit');
      await service.client.tool('flashact_create_job', { plan });
      await service.client.tool('flashact_validate_job', { jobId: plan.jobId });
      await service.client.tool('flashact_arm_job', { jobId: plan.jobId });
      await withheld;
      const receipt = await item.receipt;
      assert(receipt.accepted && !receipt.duplicate && !receipt.early);
      await exitedTransport; // Ordinary RPC deadline physically terminates the SDK worker.
      const result = await service.client.tool('flashact_get_result', { jobId: plan.jobId });
      assert.equal(result.state, 'UNKNOWN');
      assert.equal(result.executions, observed);
      const rearm = await refused(() => service.client.tool('flashact_arm_job', { jobId: plan.jobId }));
      const shutdown = await finish(service, observed ? 'SIGINT' : undefined);
      assert(shutdown.finalStatuses.some(status => status.jobId === plan.jobId && status.state === 'UNKNOWN' && status.executions === observed));
      const snapshot = await browser.evaluate('globalThis.__serviceFixture.snapshot()');
      assert.equal(snapshot.clicks.length, 1);
      assert.equal(item.receipts.length, 1);
      report.lifecycle.push({ kind: `lost-${observed}`, plan, result, receipt, rearm, shutdown, snapshot });
    } finally { await service.process.stop(); }
  }

  for (const signal of ['SIGINT', undefined]) {
    const protocolStart = report.proxy.messages.length;
    const service = await start(signal ? 'pending-sigint' : 'pending-eof');
    try {
      await service.client.tool('flashact_list_tabs', { backend: 'playwright' });
      const peer = report.proxy.messages.slice(protocolStart).find(value => value.direction === 'send')?.peer;
      assert(peer !== undefined);
      proxy.send({ command: 'mode', value: 'all-observations-after-wake' });
      await proxy.waitFor(value => value.event === 'mode' && value.value === 'all-observations-after-wake', 'pending reply hold');
      const at = Date.now() + 2000;
      const item = app.register(`pending-${randomUUID()}`, { at });
      await browser.navigate(item.url);
      const plan = planFor(item, browser, at, at + 15000);
      const withheld = proxy.waitFor(value => value.direction === 'withheld' && value.peer === peer, 'actual pending SDK reply');
      await service.client.tool('flashact_create_job', { plan });
      await service.client.tool('flashact_validate_job', { jobId: plan.jobId });
      await service.client.tool('flashact_arm_job', { jobId: plan.jobId });
      await withheld;
      const receipt = await item.receipt;
      const shutdown = await finish(service, signal);
      assert(shutdown.finalStatuses.some(status => status.jobId === plan.jobId && status.state === 'UNKNOWN' && status.executions === 0));
      assert.equal(item.receipts.length, 1);
      assert(receipt.accepted);
      report.lifecycle.push({ kind: signal ? 'pending-sigint' : 'pending-eof', plan, receipt, shutdown });
    } finally { await service.process.stop(); }
  }

  const item = app.register(`launch-stop-${randomUUID()}`, { enabled: false });
  const record = {};
  report.services.push(record);
  const home = join(root, 'launched-cli');
  const launched = recordedProcess(globalThis.process.execPath, [cliPath, 'watch', '--launch', '--headless',
    '--url', item.url, '--approved-url', item.url, '--selector', item.selector, '--when', 'enabled', '--action', 'click'],
  { ...environment, FLASHACT_HOME: home }, record);
  try {
    const waiting = await launched.waitFor(value => value.state === 'WAITING' || value.state === 'ARMED', 'actual launched owner');
    assert.equal(waiting.execution.browserOwnership, 'owned');
    const before = await exec('/bin/ps', ['-axo', 'pid=,ppid=,command=']);
    const ownedRows = before.stdout.split('\n').filter(line => line.includes(root) && line.includes('flashact-owned-'));
    assert(ownedRows.length > 0);
    await launched.stop('SIGINT');
    assert.equal(record.exit.code, 0);
    await assert.rejects(lstat(join(home, 'engine.json')), { code: 'ENOENT' });
    const after = await exec('/bin/ps', ['-axo', 'pid=,ppid=,command=']);
    assert.equal(after.stdout.split('\n').filter(line => line.includes(root) && line.includes('flashact-owned-')).length, 0);
    assert.equal(item.receipts.length, 0);
    report.lifecycle.push({ kind: 'launched-sigint', before: ownedRows, exit: record.exit, zeroEffects: true });
  } finally { await launched.stop(); }
  report.borrowedSurvives = await browser.observe('borrowed-local-browser-survives-lifecycle');
  assert(report.borrowedSurvives.hidden);
}
