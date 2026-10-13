import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { OwnedRun } from '../../scripts/visible-latency-owned.mjs';
import { matrix, preserved, reserveOutput, root } from '../../scripts/visible-latency-report.mjs';
import { fakeRun, installStopProbe } from '../fixtures/benchmark-stop-fake.mjs';

// Native ESM loading preserves Function#toString runtime hashes; Vite transforms them.
const { runVisible } = createRequire(import.meta.url)('../../scripts/visible-latency-runner.mjs');

let directory;
let restoreProbe;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'flashact-stop-unit-'));
  restoreProbe = installStopProbe();
});
afterEach(async () => {
  restoreProbe();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});
const options = () => ({ output: join(directory, 'report.json'), control: true });

describe('cooperative stop ownership', () => {
  it.each(['fixture', 'browser', 'context', 'page', 'cdp'])('disposes a late %s once without advancing', async name => {
    // Given
    const fake = fakeRun(name);
    const running = runVisible(options(), fake.adapters);
    await fake.entered.promise;
    // When
    fake.signals.emit('SIGINT'); fake.signals.emit('SIGTERM'); fake.release.resolve();
    const report = await running;
    // Then
    expect(fake.events.filter(event => event === `close:${name}`)).toHaveLength(1);
    expect(fake.events.slice(fake.events.indexOf(name) + 1).filter(event =>
      ['fixture', 'browser', 'context', 'page', 'cdp', 'runtime', 'trial'].includes(event))).toEqual([]);
    expect(report).toMatchObject({ cleanupSuccess: true, completedVisibleTrials: 0,
      lifecycle: { stopReason: 'SIGINT', pending: [] } });
    expect(fake.summaries).toHaveLength(1);
    expect(fake.signals.eventNames()).toEqual([]);
  });

  it('retains late observed clicks as an aborted row, never a completed sample', async () => {
    // Given
    const fake = fakeRun('trial');
    const running = runVisible(options(), fake.adapters);
    await fake.entered.promise;
    // When
    fake.signals.emit('SIGINT'); fake.release.resolve();
    const report = await running;
    // Then
    expect(report.completedVisibleTrials).toBe(0);
    expect(report.samples).toHaveLength(1);
    expect(report.samples[0]).toMatchObject({ success: false, aborted: true,
      evidence: 'returned-after-stop', clicks: [{ wallMs: 101 }] });
    expect(report.summary).toMatchObject({ count: 1, successes: 0, failures: 1 });
    expect(fake.trialCalls()).toBe(1);
  });

  it.each(['route', 'init', 'goto', 'Browser.getWindowForTarget', 'Browser.getVersion',
    'Browser.getBrowserCommandLine', 'runtime', 'audit'])('does not start another stage after stopping during %s', async stage => {
    // Given
    const fake = fakeRun(stage), running = runVisible(options(), fake.adapters);
    await fake.entered.promise;
    // When
    fake.signals.emit('SIGHUP'); fake.release.resolve();
    const report = await running;
    // Then
    const stopped = report.lifecycle.events.findIndex(event => event.event === 'stop');
    expect(report.lifecycle.events.slice(stopped + 1).filter(event => event.event === 'start')).toEqual([]);
    expect(report.lifecycle.stopReason).toBe('SIGHUP');
    expect(fake.signals.eventNames()).toEqual([]);
  });

  it('joins a pending checkpoint before one stable final write and summary', async () => {
    // Given
    const fake = fakeRun('checkpoint');
    const running = runVisible(options(), fake.adapters);
    await fake.entered.promise;
    // When
    fake.signals.emit('SIGINT');
    await Promise.resolve();
    expect(fake.events).not.toContain('final');
    fake.release.resolve();
    const report = await running;
    // Then
    expect(fake.events.filter(event => event.startsWith('written:') || event === 'summary'))
      .toEqual(['written:checkpoint', 'written:final', 'summary']);
    expect(JSON.parse(await readFile(report.childReportPath, 'utf8'))).toEqual(report);
    expect(report.completedVisibleTrials).toBe(1);
    expect(fake.trialCalls()).toBe(1);
  });

  it('starts owned context closure while a native operation remains pending', async () => {
    // Given
    const scope = new OwnedRun();
    const evaluation = Promise.withResolvers(), closed = Promise.withResolvers();
    await scope.acquire('context', async () => ({}), async () => { closed.resolve(); evaluation.reject(new Error('target closed')); });
    const running = scope.stage('evaluate', () => evaluation.promise).catch(error => error.message);
    // When
    scope.stop('SIGINT'); await closed.promise;
    const result = await running; await scope.drain();
    // Then
    expect(result).toBe('target closed');
    expect(scope.events.findIndex(event => event.event === 'close-start')).toBeLessThan(
      scope.events.findIndex(event => event.event === 'settled' && event.name === 'evaluate'));
    expect(scope.snapshot()).toMatchObject({ cleanupSuccess: true, pending: [] });
  });

  it('preserves the first reason and reports close failure as unconfirmed', async () => {
    // Given
    const fake = fakeRun('trial');
    fake.context.close = async () => { throw new Error('closure refused'); };
    const running = runVisible(options(), fake.adapters); await fake.entered.promise;
    // When
    fake.signals.emit('SIGTERM'); fake.signals.emit('SIGINT'); fake.release.resolve();
    const report = await running;
    // Then
    expect(report).toMatchObject({ cleanupSuccess: false, status: 'PARTIAL_OR_FAILED',
      teardown: { context: 'unconfirmed', browser: 'closed' }, lifecycle: { stopReason: 'SIGTERM' } });
    expect(report.errors).toContainEqual({ phase: 'cleanup-context', message: 'closure refused' });
  });

  it('diagnoses unsettled native closure without resolving drain or claiming success', async () => {
    // Given
    vi.useFakeTimers();
    const diagnostics = [], closure = Promise.withResolvers();
    const scope = new OwnedRun({ drainMs: 20, diagnostic: value => diagnostics.push(value) });
    await scope.acquire('context', async () => ({}), () => closure.promise);
    let drained = false;
    // When
    scope.stop('watchdog'); const drain = scope.drain().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(20);
    // Then
    expect(drained).toBe(false);
    expect(diagnostics).toMatchObject([{ status: 'SHUTDOWN_UNCONFIRMED', cleanupSuccess: false, pending: ['close:context'] }]);
    closure.resolve(); await drain;
    expect(scope.snapshot().cleanupSuccess).toBe(false);
    expect(scope.timers.size).toBe(0);
  });

  it('requests stop on a deadline but joins the underlying operation', async () => {
    // Given
    vi.useFakeTimers();
    const scope = new OwnedRun(), work = Promise.withResolvers();
    const result = scope.stage('trial', () => work.promise, 10).catch(error => error.message);
    // When
    await vi.advanceTimersByTimeAsync(10);
    expect([...scope.pending.values()]).toContain('trial');
    work.resolve('late success');
    // Then
    expect(await result).toBe('deadline:trial');
    await scope.drain();
    expect(scope.snapshot().pending).toEqual([]);
  });

  it('runs the unchanged 25-trial matrix normally and disposes each resource once', async () => {
    // Given
    const fake = fakeRun();
    // When
    const report = await runVisible({ output: join(directory, 'normal.json') }, fake.adapters);
    // Then
    expect(report).toMatchObject({ status: 'VISIBLE VERIFIED', completedVisibleTrials: 25, cleanupSuccess: true });
    expect(report.matrix).toEqual(matrix);
    expect(fake.trialCalls()).toBe(25);
    expect(new Set(report.samples.map(row => row.jobId)).size).toBe(25);
    for (const name of ['fixture', 'browser', 'context', 'page', 'cdp']) {
      expect(fake.events.filter(event => event === `close:${name}`)).toHaveLength(1);
    }
  });

  it.each(preserved)('rejects protected output %s before any fixture launch', async path => {
    // Given
    const fake = fakeRun();
    // When / Then
    await expect(runVisible({ output: join(root, path) }, fake.adapters)).rejects.toThrow('Protected output path');
    expect(fake.events).toEqual([]);
    expect(fake.signals.eventNames()).toEqual([]);
  });

  it('rejects a symlink alias without truncating the original', async () => {
    // Given
    const path = join(directory, 'alias.json');
    await symlink(join(root, 'artifacts/benchmark/visible-latency.json'), path);
    // When / Then
    await expect(reserveOutput(path)).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('imports entrypoint and runner without registering listeners or launching work', async () => {
    // Given
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const before = signals.map(signal => process.listeners(signal));
    const launch = vi.spyOn(chromium, 'launch');
    // When
    await import('../../scripts/visible-latency-benchmark.mjs');
    // Then
    expect(signals.map(signal => process.listeners(signal))).toEqual(before);
    expect(launch).not.toHaveBeenCalled();
    launch.mockRestore();
  });
});
