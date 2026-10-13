import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';

// Stop tests exercise today's runtime, not the immutable historical benchmark.
// Native loading must match the runner's Function#toString serialization.
const { runtimeSource } = createRequire(import.meta.url)('../../dist/runtime/index.js');
export function installStopProbe() {
  const readFile = fs.readFile;
  const probe = new URL('../../artifacts/benchmark/hidden-state-probe.json', import.meta.url);
  const runtimeSha256 = createHash('sha256').update(runtimeSource()).digest('hex');
  fs.readFile = async (path, encoding) => {
    const bytes = await readFile(path, encoding);
    // Hash manifest reads remain byte-for-byte real; only the gate's fixture read changes.
    if (path instanceof URL && path.href === probe.href && encoding === 'utf8') {
      return JSON.stringify({ ...JSON.parse(bytes), runtimeSha256 });
    }
    return bytes;
  };
  syncBuiltinESMExports();
  return () => { fs.readFile = readFile; syncBuiltinESMExports(); };
}

export function fakeRun(pauseAt) {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const events = [], summaries = [], signals = new EventEmitter();
  const created = new Set();
  let trialCalls = 0;
  const call = async (name, value) => {
    events.push(name);
    created.add(name);
    if (pauseAt === name) { entered.resolve(); await release.promise; }
    return value;
  };
  const resource = name => ({ close: async () => { events.push(`close:${name}`); } });
  const cdp = { detach: async () => { events.push('close:cdp'); }, send: async name => call(name, { arguments: [] }) };
  const page = { ...resource('page'), goto: async () => call('goto'), evaluate: async expression => {
    if (typeof expression === 'function') return call('audit', []);
    if (!expression.startsWith('(async function visibleTrial')) return call('runtime');
    trialCalls++;
    const options = JSON.parse(expression.slice(expression.lastIndexOf(')(') + 2, -1));
    return call('trial', { ...options, success: true, validVisibility: true, latencyMs: 1,
      clicks: [{ epochMs: 101, wallMs: 101, trusted: false }], targetWallEpochMs: 100, targetUncertaintyMs: 1 });
  } };
  const context = { ...resource('context'), route: async () => call('route'), addInitScript: async () => call('init'),
    newPage: async () => call('page', page), newCDPSession: async () => call('cdp', cdp),
    close: async () => {
      events.push('close:context');
      // Match the public native ownership contract, including created-but-not-returned children.
      if (created.has('page')) await page.close();
      if (created.has('cdp')) await cdp.detach();
    } };
  const browser = { ...resource('browser'), version: () => 'fake', newContext: async () => call('context', context) };
  return { entered, release, events, summaries, signals, browser, context, page, cdp,
    trialCalls: () => trialCalls,
    adapters: { signals, serveFixture: async () => call('fixture', { ...resource('fixture'), url: 'http://127.0.0.1:1/local.html' }),
      launch: async () => call('browser', browser), summary: value => { events.push('summary'); summaries.push(value); },
      writeReport: async (report, persist) => {
        const name = report.finishedAt ? 'final' : 'checkpoint';
        await call(name); await persist(report); events.push(`written:${name}`);
      } } };
}
