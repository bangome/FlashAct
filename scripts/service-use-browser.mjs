import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { ChromeOwner } from '../dist/adapters/playwright/chrome-owner.js';
import { createProbeDriver } from './controlled-probe-driver.mjs';

const exec = promisify(execFile);

/** QA owns stock Chrome; product endpoint clients borrow only its selected tab. */
export async function openServiceBrowser(root, url, record) {
  const directory = await mkdtemp(join(root, 'native-browser-'));
  const profile = join(directory, 'profile');
  const artifacts = join(directory, 'artifacts');
  await mkdir(profile); await mkdir(artifacts);
  const chrome = new ChromeOwner(profile, false);
  record.browser = { directory, profile, pid: chrome.child.pid, args: chrome.child.spawnargs };
  record.protocol ??= [];
  record.actions ??= [];
  let driver, stopping, endpoint, targetId, windowId;
  const close = () => {
    stopping ??= (async () => {
      const results = await Promise.allSettled([driver?.cancel(), chrome.stop()]);
      record.browser.cleanup = results.map(result => result.status);
      const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,command=']);
      const remaining = stdout.split('\n').filter(line => line.includes(profile));
      record.browser.remaining = remaining;
      assert.equal(remaining.length, 0, 'Owned native profile still has live processes');
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      await rm(directory, { recursive: true });
      record.browser.removed = true;
    })();
    return stopping;
  };
  const invoke = async (command, args = []) => {
    const timer = setTimeout(() => { void close(); }, 15000);
    try {
      const result = await driver.invoke(command, args);
      record.actions.push({ command, args, result, at: Date.now() });
      return result;
    } finally { clearTimeout(timer); }
  };
  const send = (session, method, params = {}) => invoke('send', [session, method, params]);
  const evaluate = expression => invoke('evaluate', [expression]);
  const observe = async label => {
    const page = await evaluate('({ hidden: document.hidden, visibilityState: document.visibilityState, url: location.href })');
    const target = await send('browserCDP', 'Browser.getWindowForTarget', { targetId });
    assert.equal(target.windowId, windowId);
    const native = await send('browserCDP', 'Browser.getWindowBounds', { windowId });
    const result = { label, ...page, bounds: native.bounds, targetId, windowId };
    record.visibility ??= [];
    record.visibility.push(result);
    assert.equal(page.hidden, page.visibilityState === 'hidden');
    return result;
  };
  const transition = async hidden => {
    const before = await observe(hidden ? 'before-minimize' : 'before-restore');
    assert.equal(before.hidden, !hidden, 'A fresh real visibility transition is required');
    await evaluate(`(() => {
      globalThis.__serviceVisibilityTransition = new Promise(resolve => {
        const listener = event => {
          if (!event.isTrusted || document.hidden !== ${JSON.stringify(hidden)}) return;
          document.removeEventListener('visibilitychange', listener);
          resolve({ trusted: event.isTrusted, hidden: document.hidden, at: Date.now() });
        };
        document.addEventListener('visibilitychange', listener);
      });
      return true;
    })()`);
    await send('browserCDP', 'Browser.setWindowBounds', {
      windowId, bounds: { windowState: hidden ? 'minimized' : 'normal' },
    });
    const event = await evaluate('globalThis.__serviceVisibilityTransition');
    const after = await observe(hidden ? 'after-minimize' : 'after-restore');
    assert(event.trusted && event.hidden === hidden);
    assert.equal(after.hidden, hidden);
    assert.equal(after.bounds.windowState, hidden ? 'minimized' : 'normal');
    return { event, before, after };
  };
  try {
    endpoint = await chrome.endpoint;
    const { stdout } = await exec('/bin/ps', ['-ww', '-p', String(chrome.child.pid), '-o', 'pid=', '-o', 'command=']);
    assert(stdout.includes(profile));
    record.browser.argv = stdout.trim();
    const listener = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(chrome.child.pid), '-iTCP', '-sTCP:LISTEN', '-Fpn']);
    assert(listener.stdout.includes(`n127.0.0.1:${new URL(endpoint).port}`));
    record.browser.listener = listener.stdout;
    driver = createProbeDriver({
      onProtocol: message => record.protocol.push(message),
      onExit: receipt => { record.browser.driverExit = receipt; },
    });
    await invoke('attach', [endpoint, { noDefaults: true, timeout: 10000, artifactsDir: artifacts }]);
    assert.equal(await invoke('contexts'), 1);
    await invoke('browser-session');
    await invoke('page');
    await invoke('page-session');
    await invoke('goto', [url, { waitUntil: 'load' }]);
    await invoke('front');
    const identity = await send('pageCDP', 'Target.getTargetInfo');
    targetId = identity.targetInfo.targetId;
    windowId = (await send('browserCDP', 'Browser.getWindowForTarget', { targetId })).windowId;
    record.browser.targetId = targetId;
    record.browser.windowId = windowId;
    const initial = await observe('initial-visible');
    assert.equal(initial.hidden, false);
    assert.equal(initial.bounds.windowState, 'normal');
    return {
      endpoint, targetId, windowId, evaluate, send, observe, close,
      navigate: async next => {
        await invoke('goto', [next, { waitUntil: 'load' }]);
        assert.equal(await invoke('url'), next);
      },
      minimize: () => transition(true),
      restore: () => transition(false),
      gate: async () => {
        const hidden = await transition(true);
        const visible = await transition(false);
        record.gate = { passed: true, hidden, visible };
        return record.gate;
      },
    };
  } catch (error) { await close(); throw error; }
}
