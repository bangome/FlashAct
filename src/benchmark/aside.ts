import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { AsideTransport } from '../adapters/aside/runner.js';
import { runtimeSource } from '../runtime/index.js';
import { FlashActError } from '../utils/errors.js';
import { batchExpression } from './page-batch.js';
import { batchSchema } from './browser.js';
import { summarize } from './statistics.js';
import type { ExecutionPlan } from '../core/types.js';
import { jobStatusSchema } from '../core/schema.js';

export async function runAside(url: string, options: {readonly iterations: number; readonly tabId?: string}) {
  const transport = new AsideTransport({});
  if (options.tabId) {
    const supplied = z.object({url: z.string(), title: z.string()}).parse(await transport.repl(`return (await listBrowserTabs()).find(tab => tab.targetId === ${JSON.stringify(options.tabId)});`));
    const suppliedUrl = new URL(supplied.url);
    if (!['127.0.0.1', 'localhost'].includes(suppliedUrl.hostname) || supplied.title !== 'FlashAct local benchmark') {
      throw new FlashActError('GUARD_REJECTED', 'tabId must identify an explicitly supplied task-owned local benchmark fixture');
    }
  }
  const commands = ['scheduled', 'reactive', 'and-time-first', 'and-element-first', 'or', 'simultaneous', 'replacement', 'high-cpu'].map(scenario => {
    const iterations = scenario === 'scheduled' || scenario === 'reactive' ? options.iterations : Math.min(20, options.iterations);
    return `batches.push({scenario:${JSON.stringify(scenario)},batch:JSON.parse(await owned.evaluate(${JSON.stringify(batchExpression({backend: 'aside', iterations, scenario}))}))});`;
  }).join('\n');
  const open = options.tabId ? `await attachBrowserTab(${JSON.stringify(options.tabId)})` : `await openTab(${JSON.stringify(url)})`;
  const background = batchExpression({backend: 'aside', iterations: Math.min(20, options.iterations), scenario: 'background'});
  const pending: ExecutionPlan = {schemaVersion: '1.0', jobId: 'aside-close-pending', name: 'Aside close pending', backend: 'aside',
    target: {tabId: 'owned-fixture', selector: '#reserve', url}, trigger: {type: 'SCHEDULED', at: Date.now() + 120000},
    action: {type: 'click'}, timezone: 'UTC', expiresAt: Date.now() + 180000, maxExecutions: 1,
    verification: {timeoutMs: 1000}, guards: {approvedUrl: url, allowIrreversible: false}};
  const closeExpression = `(() => {const runtime=globalThis.__flashactRuntime; runtime.install(${JSON.stringify(pending)}); return JSON.stringify({status:runtime.arm('aside-close-pending'),documentId:runtime.documentId});})()`;
  const lifecycleCode = options.tabId ? 'const lifecycle = undefined;' : `
    const previous = JSON.parse(await owned.evaluate(${JSON.stringify(closeExpression)}));
    await closeTab(owned); ownsOpenTab = false;
    let closedPageError = '';
    try { await owned.evaluate('1'); } catch (error) { if (error instanceof Error) closedPageError = error.message; else throw error; }
    const restored = await openTab(${JSON.stringify(url)});
    let fresh;
    try {
      const absent = await restored.evaluate('globalThis.__flashactRuntime === undefined');
      const documentId = await restored.evaluate(${JSON.stringify(`(${runtimeSource()}).documentId`)});
      fresh = {absent,documentId};
    } finally { await closeTab(restored); }
    const lifecycle = {previous, fresh, closedPageError};
  `;
  const value = await transport.repl(`
    const owned = ${open};
    let ownsOpenTab = ${!options.tabId};
    try {
      const initial = await snapshot(owned); console.log(initial.tree);
      if (!await owned.evaluate('Boolean(globalThis.__flashactFixture)')) throw new Error('Not a local fixture');
      await owned.evaluate(${JSON.stringify(runtimeSource())});
      const batches = [];
      ${commands}
      const foreground = await openTab(${JSON.stringify(url)});
      try { batches.push({scenario:'background',batch:JSON.parse(await owned.evaluate(${JSON.stringify(background)}))}); }
      finally { await closeTab(foreground); }
      const final = await snapshot(owned); console.log(final.diff);
      const screenshot = Buffer.from(await owned.screenshot()).toString('base64');
      ${lifecycleCode}
      return {batches,snapshot:final.tree,screenshot,lifecycle};
    } finally { if (ownsOpenTab) await closeTab(owned); }
  `);
  const parsed = z.object({batches: z.array(z.object({scenario: z.string(), batch: batchSchema})), snapshot: z.string(), screenshot: z.string(),
    lifecycle: z.object({previous: z.object({status: jobStatusSchema, documentId: z.string()}), fresh: z.object({absent: z.boolean(), documentId: z.string()}), closedPageError: z.string()}).optional()}).parse(value);
  await writeFile('artifacts/benchmark/aside-browser.png', Buffer.from(parsed.screenshot, 'base64'));
  const results = parsed.batches.map(({scenario, batch}) => ({scenario, summary: summarize(batch.samples), ...batch}));
  const lifecycle = parsed.lifecycle;
  return {
    results,
    lifecycle: lifecycle ? {...lifecycle, passed: lifecycle.previous.status.state === 'WAITING' && lifecycle.fresh.absent &&
      lifecycle.previous.documentId !== lifecycle.fresh.documentId && lifecycle.closedPageError.length > 0} : undefined,
    receipts: ['Aside extra task-owned foreground fixture tab closed via closeTab',
      options.tabId ? 'Explicitly supplied fixture tab left open' : 'Aside task-owned fixture tab closed via closeTab in finally',
      `Aside final snapshot: ${parsed.snapshot}`],
  };
}
