import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NodeScheduler } from '../dist/core/scheduler/node-scheduler.js';
import { parsePlan } from '../dist/core/schema.js';

/** Semantic cases stay separate from the simple scheduled latency population. */
export async function runCompositeCases(client, browser, app, report) {
  const scheduler = new NodeScheduler();
  report.composites = [];
  for (const kind of ['AND-current', 'OR-earlier', 'reactive']) {
    const token = `semantic-${randomUUID()}`;
    const now = Date.now();
    const first = now + 1500, second = now + 2500, enabledAt = second + 600;
    const approvalAt = kind === 'AND-current' ? enabledAt : kind === 'OR-earlier' ? first : 0;
    const item = app.register(token, { at: approvalAt, enabled: kind !== 'reactive' });
    await browser.navigate(item.url);
    assert((await browser.observe(`semantic-${kind}`)).hidden);
    await browser.evaluate(`(() => {
      const selector = ${JSON.stringify(item.ack)};
      globalThis.__semanticAck = new Promise(resolve => {
        const observer = new MutationObserver(() => {
          const ack = document.querySelector(selector);
          if (ack) { observer.disconnect(); resolve(ack.dataset.ack); }
        });
        observer.observe(document.getElementById("result"), { childList: true, subtree: true });
      });
      return Boolean(document.querySelector(selector));
    })()`).then(present => assert.equal(present, false));
    const trigger = kind === 'AND-current' ? { type: 'AND', conditions: [
      { type: 'AND', conditions: [{ type: 'SCHEDULED', at: first }, { type: 'ELEMENT_ENABLE', selector: item.selector }] },
      { type: 'SCHEDULED', at: second },
    ] } : kind === 'OR-earlier' ? { type: 'OR', conditions: [
      { type: 'SCHEDULED', at: first }, { type: 'SCHEDULED', at: second },
    ] } : { type: 'ELEMENT_ENABLE', selector: item.selector };
    const plan = parsePlan({ schemaVersion: '1.0', jobId: token, name: kind, backend: 'playwright',
      target: { tabId: browser.targetId, selector: item.selector, url: item.url }, trigger,
      action: { type: 'click' }, timezone: 'UTC', expiresAt: now + 15000, maxExecutions: 1,
      verification: { selector: item.ack, timeoutMs: 5000 },
      guards: { approvedUrl: item.url, allowIrreversible: false } });
    const cancels = [], changes = [];
    const schedule = (at, expression) => {
      const changed = new Promise((resolve, reject) => {
        let started = false;
        const cancel = scheduler.schedule(at, () => {
          started = true;
          void browser.evaluate(expression).then(resolve, reject);
        });
        cancels.push(() => { cancel(); if (!started) resolve('cancelled-before-start'); });
      });
      changes.push(changed);
    };
    try {
      if (kind === 'AND-current') {
        // An enabled condition seen at the first leaf must not latch through disable.
        schedule(first + 100, 'document.getElementById("action").disabled = true');
        schedule(enabledAt, 'globalThis.__serviceFixture.enable()');
      }
      await client.tool('flashact_create_job', { plan });
      await client.tool('flashact_validate_job', { jobId: plan.jobId });
      await client.tool('flashact_arm_job', { jobId: plan.jobId });
      if (kind === 'reactive') await browser.evaluate('globalThis.__serviceFixture.enable()');
      await browser.evaluate('globalThis.__semanticAck');
      const receipt = await item.receipt;
      const result = await client.tool('flashact_get_result', { jobId: plan.jobId });
      assert(receipt.accepted && !receipt.early && !receipt.duplicate && receipt.hidden);
      assert.equal(item.receipts.length, 1);
      assert.equal(result.state, 'VERIFIED');
      assert.equal(result.executions, 1);
      if (kind === 'OR-earlier') assert(receipt.clickWallEpochMs < second);
      if (kind === 'AND-current') assert(receipt.clickWallEpochMs >= enabledAt);
      if (kind === 'reactive') assert.equal(result.execution.reason, 'no-scheduled-leaves');
      report.composites.push({ kind, plan, receipt, result });
    } finally {
      for (const cancel of cancels) cancel();
      for (const result of await Promise.allSettled(changes)) if (result.status === 'rejected') throw result.reason;
    }
  }
}
