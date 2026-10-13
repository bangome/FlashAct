// One-time behavioral reproduction against the ORIGINAL entrypoint, before the fix.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runtimeSource } from '../../dist/runtime/index.js';
import { visibleTrial, summarizeVisible } from '../../scripts/visible-latency-page.mjs';

const original = await readFile(new URL('../../scripts/visible-latency-benchmark.mjs', import.meta.url), 'utf8');
assert.ok(original.includes('await Promise.race([run(), stop])'), 'Run RED only against original source');
const directory = await mkdtemp(join(tmpdir(), 'flashact-stop-red-'));
const evidenceDirectory = new URL('../../artifacts/qa/benchmark-stop/', import.meta.url);
await mkdir(evidenceDirectory, { recursive: true });
const receipts = [];
const deferred = () => Promise.withResolvers();
const source = original.replace(/^import .*?;\n/gms, '')
  .replaceAll('import.meta.url', JSON.stringify(new URL('../../scripts/visible-latency-benchmark.mjs', import.meta.url).href))
  .replace("const output = new URL('../artifacts/benchmark/visible-latency.json',", "const output = new URL('" + new URL(`file://${directory}/isolated.json`).href + "',");
const execute = new (Object.getPrototypeOf(async function () {}).constructor)('deps',
  'const {createHash,randomUUID,readFile,writeFile,chromium,serveFixture,runtimeSource,visibleTrial,summarizeVisible,process,console}=deps;\n' + source);

for (const scenario of ['delayed-launch', 'pending-checkpoint', 'pending-evaluate']) {
  const events = [];
  const acquired = deferred(), release = deferred(), pending = deferred(), salvage = deferred();
  const processStub = new EventEmitter();
  let realBrowser, realContext, realPage, nativeSettled = false, evaluations = 0, writes = 0;
  const row = { jobId: 'red', scenario: 'scheduled', horizonMs: 12, success: true,
    validVisibility: true, clicks: [], latencyMs: null };
  const page = { goto: async () => {}, isClosed: () => false,
    close: async () => { events.push('page.close'); },
    evaluate: async expression => {
      if (typeof expression === 'function') { salvage.resolve(); await release.promise; return {}; }
      if (++evaluations === 1) return;
      if (evaluations === 2) return row;
      throw new Error('sandbox ends producer after first checkpoint');
    } };
  const cdp = { send: async () => ({}), detach: async () => { events.push('cdp.detach'); } };
  const context = { route: async () => {}, addInitScript: async () => {}, newPage: async () => page,
    newCDPSession: async () => cdp, close: async () => { events.push('context.close'); } };
  const browser = { version: () => 'sandbox', newContext: async () => {
    events.push('newContext');
    if (scenario === 'delayed-launch') throw new Error('sandbox ends producer after observable late newContext');
    return context;
  }, close: async () => { events.push('browser.close'); } };
  try {
    if (scenario === 'pending-evaluate') {
      realBrowser = await chromium.launch({ headless: true, timeout: 15000,
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
      realContext = await realBrowser.newContext(); realPage = await realContext.newPage();
      await realPage.exposeFunction('started', () => pending.resolve());
      page.evaluate = async expression => {
        if (typeof expression === 'function') { events.push('salvage-before-close'); salvage.resolve(); await release.promise; return {}; }
        if (++evaluations === 1) return;
        try { return await realPage.evaluate(() => { globalThis.started(); return new Promise(() => {}); }); }
        finally { nativeSettled = true; events.push('native-evaluate-settled'); }
      };
      context.close = async () => { events.push('context.close'); await realContext.close(); };
      page.close = async () => { events.push('page.close'); await realPage.close(); };
      browser.close = async () => { events.push('browser.close'); await realBrowser.close(); };
    }
    const run = execute({ createHash, randomUUID, readFile, runtimeSource, visibleTrial, summarizeVisible,
      process: processStub, console: { log: () => events.push('summary') },
      serveFixture: async () => ({ url: 'http://127.0.0.1:1/local.html', close: async () => events.push('fixture.close') }),
      chromium: { launch: async () => {
        if (scenario === 'delayed-launch') { acquired.resolve(); await release.promise; }
        events.push('launch-return'); return browser;
      } },
      writeFile: async (path, bytes) => {
        if (scenario === 'pending-checkpoint' && ++writes === 1) { pending.resolve(); await release.promise; }
        events.push(JSON.parse(bytes).finishedAt ? 'final-write' : 'checkpoint-write');
        await writeFile(path, bytes);
      } });
    if (scenario === 'delayed-launch') {
      await acquired.promise; processStub.emit('SIGINT'); await run;
      release.resolve(); await new Promise(resolve => setImmediate(resolve));
    } else if (scenario === 'pending-checkpoint') {
      await pending.promise; page.isClosed = () => true; processStub.emit('SIGINT'); await run;
      release.resolve(); await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
    } else {
      await pending.promise; processStub.emit('SIGINT'); await salvage.promise;
      events.push(`pending-after-stop:${!nativeSettled}`); release.resolve(); await run;
    }
    let failure;
    try {
      switch (scenario) {
        case 'delayed-launch': assert.ok(events.includes('browser.close'), 'late acquired browser must be closed before final'); break;
        case 'pending-checkpoint': assert.ok(events.indexOf('checkpoint-write') < events.indexOf('final-write'), 'final must follow checkpoint settlement'); break;
        case 'pending-evaluate': assert.ok(!events.includes('pending-after-stop:true'), 'stop must start closure before salvage/join'); break;
      }
    } catch (error) { failure = error.message; }
    receipts.push({ scenario, status: failure ? 'RED' : 'UNEXPECTED_GREEN', failure, events });
  } finally { if (realBrowser?.isConnected()) await realBrowser.close(); }
}
const receipt = { command: 'node tests/fixtures/benchmark-stop-red.mjs', originalSourceSha256:
  createHash('sha256').update(original).digest('hex'), originalSource: original, receipts,
  cleanup: 'real owned browser closed; sandbox directory removed; protected reports read only' };
await rm(directory, { recursive: true, force: true });
await writeFile(new URL(`red-${randomUUID()}.json`, evidenceDirectory), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipts, null, 2));
process.exitCode = receipts.every(receipt => receipt.status === 'RED') ? 1 : 2;
