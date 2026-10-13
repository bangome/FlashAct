import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { serveFixture } from '../dist/benchmark/fixture.js';
import { runtimeSource } from '../dist/runtime/index.js';
import { digest, errorText, hashes, reserveOutput, root } from './visible-latency-report.mjs';
import { createProbeDriver } from './controlled-probe-driver.mjs';

// Importing this module does not acquire resources or register signal handlers.
// The default entrypoint is a provenance/visibility gate. An optional owned
// consumer runs only after its fresh complete native gate has passed.
const snapshotExpression = `(() => ({ visibilityState: document.visibilityState,
  hidden: document.hidden, epochMs: performance.timeOrigin + performance.now(), wallMs: Date.now() }))()`;

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

async function filesBelow(directory) {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  const groups = await Promise.all(entries.map(entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? filesBelow(path) : [path];
  }));
  return groups.flat().sort();
}

async function preservation(paths) {
  return { ...await hashes(), ...Object.fromEntries(await Promise.all(paths.map(async path =>
    [path, digest(await readFile(resolve(root, path)))]))), runtimeSha256: digest(runtimeSource()) };
}

function inspect(command, args, signal) {
  return new Promise((done, reject) => execFile(command, args,
    { signal, timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { stdout, stderr })) : done({ command, args, stdout, stderr })));
}

// A narrow lifecycle seam: tests exercise real ChildProcess exit/stdio behavior,
// without running Chrome or replacing the provenance/native gate.
export function joinOwnedChild(child, { onExit = () => {}, onClose = () => {} } = {}) {
  return new Promise(done => {
    child.once('exit', (code, signal) => {
      onExit({ code, signal });
      // Helpers can inherit fd2 after the exact root exits. Closing our read end
      // releases Node's stdio join; it does not claim that any helper exited.
      child.stderr?.destroy();
    });
    child.once('close', (code, signal) => {
      const receipt = { code, signal };
      onClose(receipt);
      done(receipt);
    });
  });
}

export function closeOwnedTransport(close, { pageCDP, browserCDP, page, browser }) {
  // Keep the connection alive until session/page cleanup finishes. Interruption
  // cancels and joins the isolated driver instead of depending on SDK rejection.
  const sessions = [close('pageCDP', pageCDP, value => value.detach()),
    close('browserCDP', browserCDP, value => value.detach())];
  const pageClosed = close('page', page, value => value.close({ runBeforeUnload: false }), sessions);
  close('client', browser, value => value.close(), [...sessions, pageClosed]);
}

export function recordProbeStop(report, reason) {
  report.status = 'BLOCKED';
  if (report.lifecycle.stopReason) return false;
  report.lifecycle.stopReason = reason;
  return true;
}

export async function commitProbeOutput(report, output, retireStops) {
  // Synchronous final commit boundary: all producers/cleanup have joined and
  // status is decided. Retire signal handlers BEFORE the final write begins.
  // Later signals have normal process semantics, not accepted report stops;
  // a write/close failure rejects instead of returning a successful receipt.
  retireStops();
  if (output) {
    try { await output.write(report); }
    finally { await output.close(); }
  }
}

export async function runControlledProbe({
  watchdogMs = 60000, createDriver = createProbeDriver, onNativeGate,
} = {}) {
  requireEvidence(Number.isSafeInteger(watchdogMs) && watchdogMs > 0, 'Invalid watchdogMs');
  const id = randomUUID();
  const report = { id, status: 'BLOCKED', startedAt: new Date().toISOString(), nodeVersion: process.version,
    command: 'node /Users/bogyung/FlashAct/scripts/controlled-hidden-probe.mjs', watchdogMs,
    measurementTrials: 0, hiddenTrials: 0, observations: [], cdpCommands: [], protocol: [], errors: [],
    provenance: { passed: false, targetWindowBound: false }, attachOptions: { noDefaults: true, timeout: 10000 },
    nativeGate: { passed: false, minimizationAttempts: 0 },
    restoration: { status: 'not-needed' }, lifecycle: { events: [], stopReason: null, pending: [] },
    teardown: {},
    limitations: ['Native visibility gate only; no latency, performance, SLA or site-acceptance claims.',
      'noDefaults is a candidate configuration difference, not a proven cause of prior failures.',
      'No user browser/profile/window inspection, headless mode, stealth or visibility overrides.',
      'An interrupted SDK producer is cancelled by joined driver termination; no successful cleanup claim without child close.'] };
  const abort = new AbortController();
  const pending = new Map(), closures = new Map();
  let output, profile, child, childClosed, childExit, childExited, browser, page, pageCDP, browserCDP, fixture, driver;
  let killTimer, committed = false, stderr = '', resolveEndpoint, rejectEndpoint;
  let original, hiddenObserved = false, restoredVisible = false;
  const error = (phase, value) => report.errors.push({ phase, message: errorText(value) });
  const event = (name, extra = {}) => report.lifecycle.events.push({ event: name, ...extra });
  const track = (name, value) => {
    const promise = Promise.resolve(value);
    pending.set(promise, name);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };
  const close = (name, resource, dispose, predecessors = []) => {
    if (!resource || closures.has(name)) return closures.get(name);
    report.teardown[name] = 'closing';
    event('close-start', { name });
    const promise = track(`close:${name}`, Promise.all(predecessors).then(() => dispose(resource)).then(() => {
      report.teardown[name] = 'closed'; event('closed', { name });
    }, value => {
      report.teardown[name] = driver?.stopped && ['pageCDP', 'browserCDP', 'page', 'client'].includes(name)
        ? 'cancelled-with-driver' : 'unconfirmed';
      error(`cleanup-${name}`, value);
    }));
    closures.set(name, promise);
    return promise;
  };
  const terminate = () => {
    // Establish expected close before kill can cause any child event, and before
    // draining RPC closures. Process exit and the stdio join remain distinct.
    if (child && !closures.has('child')) closures.set('child', childClosed);
    if (!child || childExited || childExit || !child.pid || killTimer) return;
    event('terminate-child', { pid: child.pid, signal: 'SIGTERM' });
    try { child.kill('SIGTERM'); } catch (value) { error('SIGTERM-child', value); }
    killTimer = setTimeout(() => {
      if (childExited || childExit) return;
      event('terminate-child', { pid: child.pid, signal: 'SIGKILL' });
      try { child.kill('SIGKILL'); } catch (value) { error('SIGKILL-child', value); }
    }, 2000);
  };
  const closeTransport = () => {
    // Never close the attached default context. Only this new page and its sessions.
    closeOwnedTransport(close, { pageCDP, browserCDP, page, browser });
  };
  const stop = reason => {
    if (committed) return;
    recordProbeStop(report, reason);
    if (!abort.signal.aborted) {
      event('stop', { reason });
      abort.abort(new Error(reason));
      rejectEndpoint?.(abort.signal.reason);
    }
    close('driver', driver, value => value.cancel());
    closeTransport();
    terminate();
  };
  const stage = async (name, operation, milliseconds = 8000) => {
    abort.signal.throwIfAborted();
    event('start', { name });
    const timer = setTimeout(() => stop(`deadline:${name}`), milliseconds);
    try {
      // Acquisition callbacks assign resources before the post-await stop check.
      const value = await track(name, operation());
      abort.signal.throwIfAborted();
      return value;
    } finally {
      clearTimeout(timer); event('settled', { name });
      if (abort.signal.aborted) { closeTransport(); terminate(); }
      if (output) await track('checkpoint', output.write({ ...report, status: 'INCOMPLETE', childStderr: stderr,
        checkpoint: { settledStage: name, at: new Date().toISOString() },
        lifecycle: { ...report.lifecycle, pending: [...pending.values()] } }));
    }
  };
  const command = async (session, method, params = {}) => {
    const receipt = { method, params, startedAt: new Date().toISOString() };
    report.cdpCommands.push(receipt);
    try {
      receipt.result = await stage(method, () => session.send(method, params));
      receipt.status = 'resolved'; return receipt.result;
    } catch (value) { receipt.status = 'failed'; receipt.error = errorText(value); throw value; }
  };
  const observe = async phase => {
    const raw = await command(pageCDP, 'Runtime.evaluate', { expression: snapshotExpression, returnByValue: true });
    requireEvidence(!raw.exceptionDetails && raw.result?.value, 'Raw visibility evaluation failed');
    const cdp = raw.result.value;
    const playwright = await stage('page-visibility', () => page.evaluate(snapshotExpression));
    const window = await command(browserCDP, 'Browser.getWindowForTarget', { targetId: report.target.targetId });
    requireEvidence(window.windowId === original.windowId, 'Owned target moved to another window');
    const native = await command(browserCDP, 'Browser.getWindowBounds', { windowId: original.windowId });
    const agree = ['visible', 'hidden'].includes(cdp.visibilityState) && typeof cdp.hidden === 'boolean'
      && cdp.hidden === (cdp.visibilityState === 'hidden')
      && cdp.visibilityState === playwright.visibilityState && cdp.hidden === playwright.hidden;
    const row = { phase, cdp, playwright, nativeBounds: native.bounds, window, agree };
    report.observations.push(row);
    return row;
  };
  const waitState = async (state, phase) => {
    const deadline = Date.now() + 5000;
    let row;
    do {
      row = await observe(phase);
      if (row.agree && row.cdp.visibilityState === state && row.cdp.hidden === (state === 'hidden')
        && row.nativeBounds.windowState === (state === 'hidden' ? 'minimized' : 'normal')) return row;
      await stage('visibility-poll-delay', () => pause(100, undefined, { signal: abort.signal }));
    } while (Date.now() < deadline);
    return row; // No fabricated reason and no second minimization attempt.
  };
  const restore = async () => {
    report.restoration.status = 'pending';
    await command(browserCDP, 'Browser.setWindowBounds', { windowId: original.windowId, bounds: { windowState: 'normal' } });
    const { left, top, width, height } = original.bounds;
    await command(browserCDP, 'Browser.setWindowBounds', { windowId: original.windowId, bounds: { left, top, width, height } });
    const row = await waitState('visible', 'after-restore');
    const boundsMatch = ['left', 'top', 'width', 'height', 'windowState'].every(key => row.nativeBounds[key] === original.bounds[key]);
    restoredVisible = row.agree && row.cdp.visibilityState === 'visible' && !row.cdp.hidden
      && row.nativeBounds.windowState === 'normal' && boundsMatch;
    report.restoration = { status: restoredVisible ? 'restored' : 'failed', boundsMatch, observed: row.nativeBounds };
  };
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => stop(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const watchdog = setTimeout(() => stop('watchdog'), watchdogMs);
  let protectedFiles = [];
  try {
    await stage('reserve-report', async () => {
      output = await reserveOutput(resolve(root, `artifacts/benchmark/controlled-hidden-probe-${id}.json`));
      report.reportPath = output.path;
    });
    protectedFiles = await stage('protected-file-list', async () => [
      ...await filesBelow('src'), ...await filesBelow('artifacts'),
      ...(await readdir(root)).filter(path => path.endsWith('.tgz')),
    ].filter(path => resolve(root, path) !== output.path));
    report.hashManifest = { before: await stage('hashes-before', () => preservation(protectedFiles)) };
    report.runtimeSha256 = report.hashManifest.before.runtimeSha256;
    await stage('installed-executable', async () => {
      const publicPath = chromium.executablePath();
      const canonicalPath = await realpath(publicPath);
      report.executable = { publicPath, canonicalPath, sha256: digest(await readFile(canonicalPath)) };
    });
    await stage('new-profile', async () => {
      profile = await mkdtemp(join(await realpath(tmpdir()), `flashact-controlled-${id}-`));
      report.profile = { path: profile, initiallyEmpty: (await readdir(profile)).length === 0 };
      requireEvidence(report.profile.initiallyEmpty, 'New owned profile was not empty');
    });
    const args = ['--enable-automation', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'];
    report.requestedLaunchArguments = args;
    await stage('spawn-child', async () => {
      child = spawn(report.executable.canonicalPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      report.child = { pid: child.pid ?? null, executable: report.executable.canonicalPath, args };
      report.teardown.child = 'open';
      childClosed = joinOwnedChild(child, { onExit: receipt => {
        childExited = receipt;
        report.child.processExit = receipt;
        report.child.stderrClosure = 'owned-read-end-destroyed-after-root-exit';
        clearTimeout(killTimer);
        event('child-exit', { pid: child.pid, ...receipt });
        rejectEndpoint?.(new Error('Child exited before endpoint acquisition'));
      }, onClose: ({ code, signal }) => {
        childExit = { code, signal }; report.child.exit = childExit;
        report.teardown.child = 'closed'; clearTimeout(killTimer);
        event('child-close', { pid: child.pid, code, signal });
        rejectEndpoint?.(new Error('Child closed before endpoint acquisition'));
        if (!closures.has('child')) stop('unexpected-child-close');
      } });
      child.on('error', value => { error('child', value); stop('child-error'); });
      child.stderr.on('data', bytes => {
        stderr = (stderr + bytes.toString()).slice(-1024 * 1024);
        const endpoints = [...stderr.matchAll(/DevTools listening on (ws:\/\/[^\s]+)/g)].map(match => match[1]);
        if (endpoints.length) resolveEndpoint?.(endpoints[0]);
      });
      requireEvidence(Number.isInteger(child.pid), 'No fresh child PID');
    });
    const endpoint = await stage('announced-endpoint', () => new Promise((done, reject) => {
      resolveEndpoint = done; rejectEndpoint = reject;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) done(match[1]);
      else if (childExit) reject(new Error('Child already exited'));
    }));
    resolveEndpoint = undefined; rejectEndpoint = undefined;
    report.announcedEndpoint = endpoint;
    const url = new URL(endpoint);
    requireEvidence(url.protocol === 'ws:' && url.hostname === '127.0.0.1' && Number(url.port) > 0
      && !url.username && !url.password && /^\/devtools\/browser\/[^/]+$/.test(url.pathname), 'Endpoint is not a loopback browser websocket');
    const ps = await stage('pid-argv', () => inspect('/bin/ps', ['-ww', '-p', String(child.pid), '-o', 'pid=', '-o', 'command='], abort.signal));
    report.child.ps = ps;
    const psLine = ps.stdout.trim();
    const psPrefix = `${child.pid} ${report.executable.canonicalPath}`;
    requireEvidence(psLine.replace(/^\s*(\d+)\s+/, '$1 ').startsWith(`${psPrefix} `)
      && args.every(arg => psLine.includes(arg)), 'Exact child PID/executable/profile argv binding failed');
    const activePort = await stage('owned-active-port', () => readFile(join(profile, 'DevToolsActivePort'), 'utf8'));
    const [port, path] = activePort.trim().split(/\r?\n/);
    report.profile.devToolsActivePort = activePort;
    requireEvidence(port === url.port && path === url.pathname, 'Owned profile endpoint binding failed');
    const listener = await stage('pid-listener', () => inspect('/usr/sbin/lsof',
      ['-nP', '-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN', '-Fpn'], abort.signal));
    report.child.listener = listener;
    const listenerLines = listener.stdout.trim().split(/\r?\n/);
    requireEvidence(listenerLines.filter(line => line.startsWith('p')).every(line => line === `p${child.pid}`)
      && listenerLines.includes(`p${child.pid}`)
      && listenerLines.includes(`n127.0.0.1:${url.port}`)
      && listenerLines.filter(line => line.startsWith('n')).every(line => /^n127\.0\.0\.1:\d+$/.test(line)),
    'Exact PID loopback-only listener binding failed');
    await stage('attach-noDefaults', async () => {
      driver = createDriver({
        onProtocol: record => report.protocol.push(record),
        onExit: receipt => { report.driverExit = receipt; event('driver-exit', receipt); },
      });
      report.teardown.driver = 'open';
      const session = name => ({
        send: (method, params) => driver.invoke('send', [name, method, params]),
        detach: () => driver.invoke('close', [name]),
      });
      // Keep SDK artifacts inside the parent-owned profile, including when
      // cancellation prevents the SDK's own temporary-directory cleanup.
      report.attachOptions.artifactsDir = profile;
      await driver.invoke('attach', [endpoint, report.attachOptions]);
      browser = {
        newBrowserCDPSession: async () => { await driver.invoke('browser-session'); return session('browserCDP'); },
        close: () => driver.invoke('close', ['browser']),
      };
      // Store the session factory without passing SDK objects across threads.
      browser.pageSession = async () => { await driver.invoke('page-session'); return session('pageCDP'); };
      report.teardown.client = 'open';
    }, 12000);
    await stage('browser-session', async () => { browserCDP = await browser.newBrowserCDPSession(); report.teardown.browserCDP = 'open'; });
    report.protocolVersion = await command(browserCDP, 'Browser.getVersion');
    report.actualCommandLine = await command(browserCDP, 'Browser.getBrowserCommandLine');
    const actualArgs = report.actualCommandLine.arguments;
    requireEvidence(Array.isArray(actualArgs) && await realpath(actualArgs[0]) === report.executable.canonicalPath
      && args.every(arg => actualArgs.includes(arg)) && !actualArgs.some(arg => arg.startsWith('--headless'))
      && actualArgs.filter(arg => arg.startsWith('--user-data-dir=')).length === 1
      && actualArgs.filter(arg => arg.startsWith('--remote-debugging-port=')).length === 1
      && actualArgs.filter(arg => arg.startsWith('--remote-debugging-address=')).length === 1,
    'CDP actual executable/profile/argv binding failed');
    requireEvidence(typeof report.protocolVersion.protocolVersion === 'string' && typeof report.protocolVersion.product === 'string',
      'Protocol version unavailable');
    report.provenance.passed = true;
    const contextCount = await stage('contexts', () => driver.invoke('contexts'));
    requireEvidence(contextCount === 1, 'Expected one fresh default context');
    await stage('owned-fixture', async () => { fixture = await serveFixture(); report.teardown.fixture = 'open'; report.fixtureUrl = fixture.url; });
    await stage('owned-page', async () => {
      await driver.invoke('page');
      page = {
        evaluate: expression => driver.invoke('evaluate',
          [typeof expression === 'function' ? `(${expression.toString()})()` : expression]),
        goto: (url, options) => driver.invoke('goto', [url, options]),
        bringToFront: () => driver.invoke('front'),
        close: () => driver.invoke('close', ['page']),
      };
      report.teardown.page = 'open';
    });
    await stage('audit-init', () => driver.invoke('init', [`(${(() => {
      globalThis.__controlledVisibilityAudit = [];
      const capture = event => globalThis.__controlledVisibilityAudit.push({
        kind: event ? 'visibilitychange' : 'initial', isTrusted: event?.isTrusted ?? null,
        visibilityState: document.visibilityState, hidden: document.hidden,
        epochMs: performance.timeOrigin + performance.now(), wallMs: Date.now(),
      });
      document.addEventListener('visibilitychange', capture); capture();
    }).toString()})()`]));
    await stage('owned-navigation', () => page.goto(fixture.url, { waitUntil: 'load', timeout: 10000 }), 12000);
    await stage('page-session', async () => { pageCDP = await browser.pageSession(); report.teardown.pageCDP = 'open'; });
    const target = await command(pageCDP, 'Target.getTargetInfo');
    report.target = target.targetInfo;
    const pageUrl = await stage('page-url', () => driver.invoke('url'));
    requireEvidence(report.target.type === 'page' && report.target.url === fixture.url && pageUrl === fixture.url
      && typeof report.target.targetId === 'string', 'Exact owned target/URL binding failed');
    original = await command(browserCDP, 'Browser.getWindowForTarget', { targetId: report.target.targetId });
    report.originalWindow = original;
    requireEvidence(Number.isInteger(original.windowId) && original.bounds.windowState === 'normal'
      && ['left', 'top', 'width', 'height'].every(key => Number.isFinite(original.bounds[key])), 'Original owned window is not normal with finite geometry');
    report.provenance.targetWindowBound = true;
    await stage('owned-front', () => page.bringToFront());
    const before = await waitState('visible', 'before-minimize');
    requireEvidence(before.agree && before.cdp.visibilityState === 'visible' && !before.cdp.hidden
      && before.nativeBounds.windowState === 'normal', 'Initial native visible gate failed');
    report.nativeGate.minimizationAttempts = 1;
    report.restoration.status = 'pending';
    try {
      await command(browserCDP, 'Browser.setWindowBounds', { windowId: original.windowId, bounds: { windowState: 'minimized' } });
      const hidden = await waitState('hidden', 'after-minimize');
      hiddenObserved = hidden.agree && hidden.cdp.visibilityState === 'hidden' && hidden.cdp.hidden
        && hidden.nativeBounds.windowState === 'minimized';
    } finally {
      // Stop never begins further page work: exact child termination is the fallback.
      if (!abort.signal.aborted) await restore();
      else report.restoration.status = 'interrupted-child-termination-required';
    }
    report.visibilityAudit = await stage('visibility-audit', () => page.evaluate(() => globalThis.__controlledVisibilityAudit));
    const audit = report.visibilityAudit;
    const hiddenIndex = audit.findIndex(row => row.kind === 'visibilitychange' && row.isTrusted === true
      && row.visibilityState === 'hidden' && row.hidden === true);
    const visibleIndex = audit.findIndex((row, index) => index > hiddenIndex && row.kind === 'visibilitychange'
      && row.isTrusted === true && row.visibilityState === 'visible' && row.hidden === false);
    report.nativeGate = { ...report.nativeGate, hiddenObserved, restoredVisible,
      actualVisibilitychangeSequence: hiddenIndex > 0 && visibleIndex > hiddenIndex
        && audit[hiddenIndex - 1].visibilityState === 'visible' && audit[hiddenIndex - 1].hidden === false,
      passed: false };
    report.nativeGate.passed = hiddenObserved && restoredVisible && report.nativeGate.actualVisibilitychangeSequence;
    if (report.nativeGate.passed && onNativeGate) {
      await stage('native-gated-consumer', () => onNativeGate({
        report, page, pageCDP, browserCDP, original, command, stage, observe, waitState, restore, signal: abort.signal,
      }), watchdogMs);
    }
  } catch (value) {
    error('probe', value);
    stop(errorText(value));
  } finally {
    // All acquisition producers have settled before profile deletion. No Promise.race.
    const cleanupDeadline = setTimeout(() => {
      stop('deadline:cleanup');
      // A durable pending diagnostic is not a successful join or a watchdog
      // termination guarantee. This write itself is tracked and joined.
      if (output) void track('cleanup-checkpoint', output.write({ ...report, status: 'BLOCKED',
        cleanupSuccess: false, childStderr: stderr,
        lifecycle: { ...report.lifecycle, pending: [...pending.values()], cleanupPending: true },
      })).catch(value => error('cleanup-checkpoint', value));
    }, 8000);
    closeTransport();
    while (pending.size) await Promise.allSettled([...pending.keys()]);
    // Successful session/page/disconnect work precedes Chrome termination.
    // On interruption stop() already joined driver cancellation and signalled Chrome.
    await close('driver', driver, value => value.cancel());
    terminate();
    if (child) {
      await childClosed;
    }
    while (pending.size) await Promise.allSettled([...pending.keys()]);
    await close('fixture', fixture, value => value.close());
    if (profile) {
      try {
        requireEvidence(!child || Boolean(childExit), 'Refusing profile deletion before exact child close');
        await rm(profile, { recursive: true, force: false });
        report.teardown.profile = 'removed-after-child-exit';
      } catch (value) { report.teardown.profile = 'unconfirmed'; error('cleanup-profile', value); }
    }
    clearTimeout(cleanupDeadline); clearTimeout(killTimer); clearTimeout(watchdog);
    // The cleanup diagnostic may have started while fixture/profile disposal
    // was awaited. Join it before the final write can touch the same inode.
    while (pending.size) await Promise.allSettled([...pending.keys()]);
    report.childStderr = stderr;
    report.lifecycle.pending = [...pending.values()];
    report.cleanupSuccess = pending.size === 0 && Object.values(report.teardown).every(state =>
      ['closed', 'removed-after-child-exit'].includes(state)
      || (state === 'cancelled-with-driver' && report.teardown.driver === 'closed' && (!child || Boolean(childExit))));
    try {
      const after = await preservation(protectedFiles);
      report.hashManifest = { ...report.hashManifest, after,
        unchanged: Boolean(report.hashManifest?.before) && JSON.stringify(report.hashManifest.before) === JSON.stringify(after) };
    } catch (value) { error('hash-preservation', value); }
    report.status = report.provenance.passed && report.provenance.targetWindowBound && report.nativeGate.passed && report.cleanupSuccess
      && report.hashManifest?.unchanged && !report.lifecycle.stopReason && report.errors.length === 0
      ? 'HIDDEN_GATE_VERIFIED' : 'BLOCKED';
    report.finishedAt = new Date().toISOString();
    await commitProbeOutput(report, output, () => {
      committed = true;
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error('Usage: node scripts/controlled-hidden-probe.mjs (no arguments; UUID exclusive report)');
    process.exitCode = 1;
  } else {
    try {
      const report = await runControlledProbe();
      console.log(JSON.stringify({ status: report.status, output: report.reportPath, hiddenTrials: report.hiddenTrials,
        cleanupSuccess: report.cleanupSuccess, errors: report.errors }));
      if (report.status !== 'HIDDEN_GATE_VERIFIED') process.exitCode = 1;
    } catch (value) { console.error(errorText(value)); process.exitCode = 1; }
  }
}
