import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AdapterOwner, BrowserAdapter } from '../../src/adapters/browser-adapter.js';
import { JobEngine, isTerminal } from '../../src/core/engine.js';
import { jobStatusSchema } from '../../src/core/schema.js';
import type { Scheduler } from '../../src/core/scheduler/node-scheduler.js';
import type { ExecutionPlan, JobStatus, TargetInfo } from '../../src/core/types.js';
import { FlashActError } from '../../src/utils/errors.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { foreground } from '../../src/cli/foreground.js';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const plan: ExecutionPlan = {
  schemaVersion: '1.0', jobId: 'job', name: 'test', backend: 'playwright',
  target: { tabId: 'tab', selector: '#button', url: 'https://example.test/' },
  trigger: { type: 'ELEMENT_ENABLE', selector: '#button' }, action: { type: 'click' }, timezone: 'UTC',
  expiresAt: 10000, maxExecutions: 1, verification: { timeoutMs: 100 },
  guards: { approvedUrl: 'https://example.test/', allowIrreversible: false },
};

class MemoryAdapter implements BrowserAdapter {
  target: TargetInfo = { selector: '#button', count: 1, enabled: true, visible: true, irreversible: false, url: plan.target.url };
  readonly statuses = new Map<string, JobStatus>();
  readonly cleanup: string[] = [];
  async connect() {}
  async listTabs() { return [{ id: 'tab', url: this.target.url, title: '' }]; }
  async selectTab(id: string) { if (id !== 'tab') throw new FlashActError('ADAPTER_ERROR', 'No tab'); }
  async inspectTarget() { return this.target; }
  async installRuntime(input: ExecutionPlan) {
    this.statuses.set(input.jobId, { jobId: input.jobId, state: 'VALIDATED', executions: 0, updatedAt: 1 });
    return { jobId: input.jobId, documentId: 'doc' };
  }
  async arm(input: ExecutionPlan) { this.statuses.set(input.jobId, { jobId: input.jobId, state: 'WAITING', executions: 0, updatedAt: 1 }); }
  async cancel(id: string) { this.cleanup.push(`cancel:${id}`); this.statuses.set(id, { jobId: id, state: 'CANCELLED', executions: 0, updatedAt: 2 }); }
  async getStatus(id: string) {
    const status = this.statuses.get(id);
    if (!status) throw new FlashActError('JOB_NOT_FOUND', 'No runtime');
    return status;
  }
  async evaluate() { return null; }
  async disconnect() { this.cleanup.push('disconnect'); }
}

function fixture() {
  const adapter = new MemoryAdapter();
  return { adapter, engine: new JobEngine({ adapters: { playwright: adapter, aside: adapter }, now: () => 100 }) };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class ManualScheduler implements Scheduler {
  readonly entries: { at: number; callback: () => void; cancelled: boolean }[] = [];
  schedule(at: number, callback: () => void) {
    const entry = { at, callback, cancelled: false };
    this.entries.push(entry);
    return () => { entry.cancelled = true; };
  }
}

class OwnedMemoryAdapter extends MemoryAdapter {
  readonly listeners = new Set<(status: JobStatus) => void>();
  readonly wakes: string[] = [];
  readonly producerEvents: string[] = [];
  heldStatus: ReturnType<typeof deferred<JobStatus>> | undefined;
  readonly statusStarted = deferred<void>();
  private stopped: Promise<readonly JobStatus[]> | undefined;
  readonly owner: AdapterOwner = {
    kind: 'endpoint-client',
    subscribe: listener => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; },
    stop: () => {
      if (this.stopped) return this.stopped;
      this.producerEvents.push('producer-exited');
      for (const status of this.statuses.values()) {
        if (!isTerminal(status.state)) this.emit({ ...status, state: 'UNKNOWN' });
      }
      this.heldStatus?.reject(new FlashActError('ADAPTER_ERROR', 'Producer exited'));
      this.heldStatus = undefined;
      this.stopped = Promise.resolve([...this.statuses.values()]);
      return this.stopped;
    },
  };
  emit(status: JobStatus) {
    this.statuses.set(status.jobId, status);
    for (const listener of this.listeners) listener(status);
  }
  override async getStatus(id: string): Promise<JobStatus> {
    if (!this.heldStatus) return super.getStatus(id);
    this.statusStarted.resolve();
    try { return await this.heldStatus.promise; }
    catch (error) {
      this.producerEvents.push('sdk-rejected');
      throw error;
    }
  }
  async wake(id: string): Promise<JobStatus> {
    this.wakes.push(id);
    return super.getStatus(id);
  }
  override async cancel(id: string) {
    await super.cancel(id);
    this.emit(await super.getStatus(id));
  }
  override async disconnect() {
    await this.owner.stop('shutdown');
    await super.disconnect();
  }
}

async function ownedFixture(trigger: ExecutionPlan['trigger'] = { type: 'SCHEDULED', at: 200 }) {
  const adapter = new OwnedMemoryAdapter();
  const scheduler = new ManualScheduler();
  const engine = new JobEngine({ adapters: { playwright: adapter }, adapterMode: 'owned',
    scheduling: 'auto', scheduler, now: () => 100 });
  await engine.createJob({ ...plan, trigger });
  await engine.validateJob('job');
  await engine.armJob('job');
  return { adapter, scheduler, engine };
}

describe('owned engine scheduling and retention', () => {
  it('publishes safe timing evidence once and retains late UNKNOWN before unsubscribing', async () => {
    // Given
    const { engine, adapter } = await ownedFixture();
    const observations: JobStatus[] = [];
    const unsubscribe = engine.subscribe(status => observations.push(status));
    try {
      // When
      adapter.emit({ jobId: 'job', state: 'WAITING', executions: 0, updatedAt: 101 });
      adapter.emit({ jobId: 'job', state: 'WAITING', executions: 0, updatedAt: 102,
        timing: { observerEpochMs: 101 }, message: 'page-secret' });
      adapter.emit({ jobId: 'job', state: 'WAITING', executions: 0, updatedAt: 103, timing: { observerEpochMs: 101 } });
      adapter.emit({ jobId: 'job', state: 'UNKNOWN', executions: 0, updatedAt: 104 });
      adapter.emit({ jobId: 'job', state: 'ARMED', executions: 0, updatedAt: 1 });
      adapter.emit({ jobId: 'job', state: 'VERIFIED', executions: 1, updatedAt: 105 });
      unsubscribe();
      adapter.emit({ jobId: 'job', state: 'UNKNOWN', executions: 1, updatedAt: 106, timing: { observerEpochMs: 105 } });
      // Then
      expect(observations.map(status => [status.state, status.executions, status.timing])).toEqual([
        ['WAITING', 0, undefined], ['WAITING', 0, { observerEpochMs: 101 }],
        ['UNKNOWN', 0, { observerEpochMs: 101 }], ['UNKNOWN', 1, { observerEpochMs: 101 }],
      ]);
      expect(observations.every(status => status.message === undefined)).toBe(true);
    } finally { unsubscribe(); await engine.close(); }
  });

  it('prints foreground timing and verification events during its single held reconciliation and cleans up', async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), 'flashact-foreground-events-'));
    vi.stubEnv('FLASHACT_HOME', home);
    const adapter = new OwnedMemoryAdapter();
    adapter.heldStatus = deferred<JobStatus>();
    const engine = new JobEngine({ adapters: { playwright: adapter }, now: () => 100 });
    const read = vi.spyOn(adapter, 'getStatus');
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const controller = new AbortController();
    const running = foreground(engine, plan, controller.signal);
    try {
      await adapter.statusStarted.promise;
      // When
      adapter.emit({ jobId: 'job', state: 'DISPATCHED', executions: 1, updatedAt: 101 });
      adapter.emit({ jobId: 'job', state: 'DISPATCHED', executions: 1, updatedAt: 102, timing: { clickEpochMs: 101 } });
      adapter.emit({ jobId: 'job', state: 'VERIFIED', executions: 1, updatedAt: 103, timing: { clickEpochMs: 101 } });
      // Then: synchronous push is observable before the held read completes.
      const lines = output.mock.calls.map(([line]) => jobStatusSchema.parse(JSON.parse(String(line))));
      expect(lines.slice(-3)).toMatchObject([
        { state: 'DISPATCHED', executions: 1 },
        { state: 'DISPATCHED', timing: { clickEpochMs: 101 } },
        { state: 'VERIFIED', executions: 1, timing: { clickEpochMs: 101 } },
      ]);
      expect(read).toHaveBeenCalledTimes(1);
      const count = output.mock.calls.length;
      controller.abort();
      await engine.close();
      await running;
      adapter.emit({ jobId: 'job', state: 'VERIFIED', executions: 1, updatedAt: 104, timing: { observerEpochMs: 104 } });
      expect(output.mock.calls.length).toBe(count);
      expect(adapter.listeners.size).toBe(0);
      expect(adapter.producerEvents).toEqual(['producer-exited', 'sdk-rejected']);
      await expect(access(join(home, 'engine.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      controller.abort(); await engine.close(); await running;
      output.mockRestore(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true });
    }
  });

  it('waits on events after initial foreground reconciliation instead of polling and unsubscribes', async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), 'flashact-foreground-idle-'));
    vi.stubEnv('FLASHACT_HOME', home);
    const adapter = new OwnedMemoryAdapter();
    const engine = new JobEngine({ adapters: { playwright: adapter }, now: () => 100 });
    const subscribe = engine.subscribe.bind(engine);
    const unsubscribed = vi.fn();
    vi.spyOn(engine, 'subscribe').mockImplementation(listener => {
      const dispose = subscribe(listener);
      return () => { unsubscribed(); dispose(); };
    });
    const reconciled = deferred<void>();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(line => {
      const status = jobStatusSchema.parse(JSON.parse(String(line)));
      if (status.state === 'WAITING') reconciled.resolve();
      return true;
    });
    const read = vi.spyOn(adapter, 'getStatus');
    const controller = new AbortController();
    const running = foreground(engine, plan, controller.signal);
    try {
      await reconciled.promise;
      vi.useFakeTimers();
      // When
      await vi.advanceTimersByTimeAsync(1000);
      adapter.emit({ jobId: 'job', state: 'VERIFIED', executions: 1, updatedAt: 101 });
      // Then
      expect(read).toHaveBeenCalledTimes(1);
      expect(jobStatusSchema.parse(JSON.parse(String(output.mock.calls.at(-1)?.[0])))).toMatchObject({ state: 'VERIFIED', executions: 1 });
      controller.abort();
      await running;
      expect(unsubscribed).toHaveBeenCalledTimes(1);
      expect(adapter.producerEvents).toEqual(['producer-exited']);
    } finally {
      vi.useRealTimers(); controller.abort(); await engine.close(); await running;
      output.mockRestore(); vi.restoreAllMocks(); vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps browser expiry authoritative when a host expiry wake finds a waiting runtime', async () => {
    // Given
    const { engine, adapter, scheduler } = await ownedFixture();
    const expiry = scheduler.entries.find(entry => entry.at === plan.expiresAt);
    if (!expiry) throw new FlashActError('INVALID_STATE', 'Missing expiry schedule');
    try {
      // When
      expiry.callback();
      // Then
      expect(adapter.wakes).toEqual(['job']);
      expect(await engine.getStatus('job')).toMatchObject({ state: 'WAITING', executions: 0 });
    } finally { await engine.close(); }
  });

  it('rejects an unowned injected adapter without acquiring it in owned mode', async () => {
    // Given
    const adapter = new MemoryAdapter();
    const connect = vi.spyOn(adapter, 'connect');
    const engine = new JobEngine({ adapters: { playwright: adapter }, adapterMode: 'owned', now: () => 100 });
    await engine.createJob(plan);
    try {
      // When / Then
      await expect(engine.validateJob('job')).rejects.toMatchObject({ code: 'INVALID_PLAN' });
      expect(connect).not.toHaveBeenCalled();
    } finally { await engine.close(); }
  });

  it('joins and rejects a connection acknowledgement that arrives during close', async () => {
    // Given
    const adapter = new OwnedMemoryAdapter();
    const connecting = deferred<void>();
    const released = deferred<void>();
    vi.spyOn(adapter, 'connect').mockImplementation(async () => { connecting.resolve(); await released.promise; });
    const stop = adapter.owner.stop.bind(adapter.owner);
    vi.spyOn(adapter.owner, 'stop').mockImplementation(reason => {
      const joined = stop(reason);
      released.resolve();
      return joined;
    });
    const list = vi.spyOn(adapter, 'listTabs');
    const engine = new JobEngine({ adapters: { playwright: adapter }, adapterMode: 'owned', now: () => 100 });
    const listing = engine.listTabs('playwright').catch(error => error);
    await connecting.promise;
    // When
    const closing = engine.close();
    // Then
    expect(engine.close()).toBe(closing);
    await closing;
    expect(await listing).toMatchObject({ code: 'INVALID_STATE' });
    expect(list).not.toHaveBeenCalled();
    expect(adapter.producerEvents).toEqual(['producer-exited']);
  });

  it('retains final local results without reconnecting after close', async () => {
    // Given
    const { engine, adapter } = await ownedFixture();
    const connect = vi.spyOn(adapter, 'connect');
    adapter.emit({ jobId: 'job', state: 'VERIFIED', executions: 1, updatedAt: 101 });
    await engine.close();
    // When
    const result = await engine.getResult('job');
    // Then
    expect(result).toMatchObject({ state: 'VERIFIED', executions: 1 });
    expect(connect).not.toHaveBeenCalled();
    await expect(engine.armJob('job')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('starts a deadline wake while an ordinary status producer is pending', async () => {
    // Given
    const { engine, adapter, scheduler } = await ownedFixture();
    adapter.heldStatus = deferred<JobStatus>();
    const reading = engine.getStatus('job');
    await adapter.statusStarted.promise;
    const entry = scheduler.entries.find(entry => entry.at === 200);
    if (!entry) throw new FlashActError('INVALID_STATE', 'Missing leaf schedule');
    try {
      // When
      entry.callback();
      // Then
      expect(adapter.wakes).toEqual(['job']);
      expect((await engine.close(), await reading).state).toBe('CANCELLED');
      expect(adapter.producerEvents).toEqual(['producer-exited', 'sdk-rejected']);
    } finally { await engine.close(); }
  });

  it.each(['AND', 'OR'] as const)('schedules distinct leaves rather than only the maximum for %s', async type => {
    // Given
    const { engine, scheduler } = await ownedFixture({ type, conditions: [
      { type: 'SCHEDULED', at: 200 }, { type: 'SCHEDULED', at: 300 },
      { type: 'SCHEDULED', at: 200 }, { type: 'SCHEDULED', at: 10000 },
    ] });
    try {
      // When
      const times = scheduler.entries.map(entry => entry.at);
      // Then
      expect(times).toEqual([200, 300, 10000]);
    } finally { await engine.close(); }
  });

  it('collapses past leaf deadlines into one asynchronous readiness callback', async () => {
    // Given
    const { engine, scheduler } = await ownedFixture({ type: 'OR', conditions: [
      { type: 'SCHEDULED', at: 50 }, { type: 'SCHEDULED', at: 80 }, { type: 'SCHEDULED', at: 200 },
    ] });
    try {
      // When
      const times = scheduler.entries.map(entry => entry.at);
      // Then
      expect(times).toEqual([200, 100, 10000]);
    } finally { await engine.close(); }
  });

  it('does not invent host polling or deadlines for reactive auto jobs', async () => {
    // Given
    const { engine, scheduler } = await ownedFixture(plan.trigger);
    try {
      // When
      const status = await engine.getStatus('job');
      // Then
      expect(scheduler.entries).toEqual([]);
      expect(status.execution).toMatchObject({ scheduler: 'browser', reason: 'no-scheduled-leaves' });
    } finally { await engine.close(); }
  });

  it('retains a confirmed dispatch against an older waiting reply', async () => {
    // Given
    const { engine, adapter } = await ownedFixture();
    adapter.emit({ jobId: 'job', state: 'DISPATCHED', executions: 1, updatedAt: 101, timing: { clickEpochMs: 101 } });
    adapter.statuses.set('job', { jobId: 'job', state: 'WAITING', executions: 0, updatedAt: 1 });
    try {
      // When
      const status = await engine.getStatus('job');
      // Then
      expect(status).toMatchObject({ state: 'DISPATCHED', executions: 1, timing: { clickEpochMs: 101 } });
    } finally { await engine.close(); }
  });

  it('logs new execution evidence without reviving an unknown job', async () => {
    // Given
    const { engine, adapter } = await ownedFixture();
    adapter.emit({ jobId: 'job', state: 'UNKNOWN', executions: 0, updatedAt: 101 });
    // When
    adapter.emit({ jobId: 'job', state: 'VERIFIED', executions: 1, updatedAt: 102 });
    try {
      // Then
      expect(await engine.getResult('job')).toMatchObject({ state: 'UNKNOWN', executions: 1 });
      expect(engine.logs().at(-1)).toMatchObject({ state: 'UNKNOWN', executions: 1 });
    } finally { await engine.close(); }
  });

  it('retains a verified observation that precedes an arm acknowledgement', async () => {
    // Given
    const adapter = new OwnedMemoryAdapter();
    const engine = new JobEngine({ adapters: { playwright: adapter }, scheduling: 'auto', now: () => 100 });
    vi.spyOn(adapter, 'arm').mockImplementation(async () => {
      adapter.emit({ jobId: 'job', state: 'VERIFIED', executions: 1, updatedAt: 101 });
    });
    await engine.createJob(plan); await engine.validateJob('job');
    try {
      // When
      const result = await engine.armJob('job');
      // Then
      expect(result).toMatchObject({ state: 'VERIFIED', executions: 1 });
    } finally { await engine.close(); }
  });

  it('prevents a dequeued leaf callback from starting after cancellation', async () => {
    // Given
    const { engine, adapter, scheduler } = await ownedFixture();
    const entry = scheduler.entries.find(entry => entry.at === 200);
    if (!entry) throw new FlashActError('INVALID_STATE', 'Missing leaf schedule');
    await engine.cancelJob('job');
    try {
      // When
      entry.callback();
      // Then
      expect(adapter.wakes).toEqual([]);
      expect(scheduler.entries.every(entry => entry.cancelled)).toBe(true);
    } finally { await engine.close(); }
  });

  it('admits cancellation before a stalled status read and joins the producer at its deadline', async () => {
    // Given
    vi.useFakeTimers();
    const { engine, adapter } = await ownedFixture();
    adapter.heldStatus = deferred<JobStatus>();
    const reading = engine.getStatus('job');
    await adapter.statusStarted.promise;
    const cancelled = deferred<void>();
    vi.spyOn(adapter, 'cancel').mockImplementation(async id => {
      adapter.emit({ jobId: id, state: 'CANCELLED', executions: 0, updatedAt: 101 });
      cancelled.resolve();
    });
    try {
      // When
      const cancellation = engine.cancelJob('job');
      await cancelled.promise;
      await vi.advanceTimersByTimeAsync(2000);
      // Then
      expect(await cancellation).toMatchObject({ state: 'CANCELLED', executions: 0 });
      expect(await reading).toMatchObject({ state: 'CANCELLED', executions: 0 });
      expect(adapter.producerEvents).toEqual(['producer-exited', 'sdk-rejected']);
    } finally { await engine.close(); vi.useRealTimers(); }
  });

  it('does not arm when cancellation arrives during runtime installation', async () => {
    // Given
    const adapter = new OwnedMemoryAdapter();
    const engine = new JobEngine({ adapters: { playwright: adapter }, scheduling: 'auto', now: () => 100 });
    const installed = deferred<void>();
    const release = deferred<void>();
    const install = adapter.installRuntime.bind(adapter);
    vi.spyOn(adapter, 'installRuntime').mockImplementation(async input => {
      installed.resolve(); await release.promise; return install(input);
    });
    const arm = vi.spyOn(adapter, 'arm');
    await engine.createJob(plan); await engine.validateJob('job');
    const arming = engine.armJob('job').catch(error => error);
    await installed.promise;
    try {
      // When
      const cancellation = engine.cancelJob('job');
      release.resolve();
      // Then
      expect(await cancellation).toMatchObject({ state: 'CANCELLED', executions: 0 });
      expect(await arming).toMatchObject({ code: 'INVALID_STATE' });
      expect(arm).not.toHaveBeenCalled();
    } finally { await engine.close(); }
  });

  it('rejects explicit host mode on a cooperative adapter before installation', async () => {
    // Given
    const adapter = new MemoryAdapter();
    const engine = new JobEngine({ adapters: { playwright: adapter }, scheduling: 'host', now: () => 100 });
    await engine.createJob(plan);
    try {
      // When / Then
      await expect(engine.validateJob('job')).rejects.toMatchObject({ code: 'INVALID_PLAN' });
      expect(adapter.statuses.size).toBe(0);
      expect(engine.capabilities()[0]).toMatchObject({ hostWake: false, shutdown: 'cooperative' });
    } finally { await engine.close(); }
  });
});

describe('foreground engine', () => {
  it('keeps a runtime waiting when status is polled', async () => {
    // Given
    const { engine, adapter } = fixture();
    await engine.createJob(plan); await engine.validateJob('job'); await engine.armJob('job');
    try {
      // When
      const statuses = await Promise.all([engine.getStatus('job'), engine.getStatus('job')]);
      // Then
      expect(statuses.map(status => [status.state, status.executions])).toEqual([['WAITING', 0], ['WAITING', 0]]);
      expect(adapter.statuses.size).toBe(1);
    } finally { await engine.close(); }
  });
  it.each([
    { count: 2 }, { count: 0 }, { url: 'https://elsewhere.test/' }, { irreversible: true },
  ])('rejects unsafe targets before runtime installation when %j', async target => {
    // Given
    const { engine, adapter } = fixture(); adapter.target = { ...adapter.target, ...target };
    await engine.createJob(plan);
    try {
      // When / Then
      await expect(engine.validateJob('job')).rejects.toMatchObject({ code: 'GUARD_REJECTED' });
      expect(adapter.statuses.size).toBe(0);
    } finally { await engine.close(); }
  });
  it('rechecks URL when navigation occurs after validation', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job');
    adapter.target = { ...adapter.target, url: 'https://elsewhere.test/' };
    try {
      // When / Then
      await expect(engine.armJob('job')).rejects.toMatchObject({ code: 'GUARD_REJECTED' });
      expect(adapter.statuses.size).toBe(0);
    } finally { await engine.close(); }
  });
  it('allows a missing target when an APPEAR condition gates it', async () => {
    // Given
    const { engine, adapter } = fixture(); adapter.target = { ...adapter.target, count: 0 };
    await engine.createJob({ ...plan, trigger: { type: 'ELEMENT_APPEAR', selector: '#button' } });
    try {
      // When
      const status = await engine.validateJob('job');
      // Then
      expect(status.state).toBe('VALIDATED');
    } finally { await engine.close(); }
  });
  it('cancels installed jobs before disconnect when closing', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job'); await engine.armJob('job');
    // When
    await engine.close();
    // Then
    expect(adapter.cleanup).toEqual(['cancel:job', 'disconnect']);
  });
  it('redacts browser messages when returning status and logs', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job'); await engine.armJob('job');
    adapter.statuses.set('job', { jobId: 'job', state: 'VERIFIED', executions: 1, updatedAt: 101, message: 'cookie=secret https://example.test/?token=secret' });
    try {
      // When
      const output = JSON.stringify([await engine.getStatus('job'), engine.logs()]);
      // Then
      expect(output).not.toContain('secret');
    } finally { await engine.close(); }
  });
  it('retains a verified dispatch when the arm acknowledgement and cancellation transport fail', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job');
    vi.spyOn(adapter, 'arm').mockImplementation(async () => {
      adapter.statuses.set('job', { jobId: 'job', state: 'VERIFIED', executions: 1, updatedAt: 101 });
      throw new FlashActError('ADAPTER_ERROR', 'Arm acknowledgement lost');
    });
    vi.spyOn(adapter, 'cancel').mockRejectedValue(new FlashActError('ADAPTER_ERROR', 'Cancellation transport lost'));
    try {
      // When
      await expect(engine.armJob('job')).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
      const result = await engine.getResult('job');
      // Then
      expect(result).toMatchObject({ state: 'VERIFIED', executions: 1 });
    } finally { await Promise.allSettled([engine.close()]); }
  });
  it('returns UNKNOWN without permitting rearm when all dispatch acknowledgement paths are lost', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job');
    vi.spyOn(adapter, 'arm').mockImplementation(async () => {
      adapter.statuses.set('job', { jobId: 'job', state: 'VERIFIED', executions: 1, updatedAt: 101 });
      throw new FlashActError('ADAPTER_ERROR', 'Arm acknowledgement lost');
    });
    vi.spyOn(adapter, 'cancel').mockRejectedValue(new FlashActError('ADAPTER_ERROR', 'Cancellation transport lost'));
    vi.spyOn(adapter, 'getStatus').mockRejectedValue(new FlashActError('ADAPTER_ERROR', 'Status transport lost'));
    try {
      // When
      await expect(engine.armJob('job')).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
      const result = await engine.getResult('job');
      // Then
      expect(result.state).toBe('UNKNOWN');
      await expect(engine.armJob('job')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    } finally { await Promise.allSettled([engine.close()]); }
  });
  it('preserves the observed execution count when reconciliation loses a dispatched job', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job');
    vi.spyOn(adapter, 'arm').mockRejectedValue(new FlashActError('ADAPTER_ERROR', 'Arm acknowledgement lost'));
    vi.spyOn(adapter, 'getStatus').mockResolvedValueOnce({ jobId: 'job', state: 'DISPATCHED', executions: 1, updatedAt: 101 })
      .mockRejectedValue(new FlashActError('ADAPTER_ERROR', 'Status transport lost'));
    vi.spyOn(adapter, 'cancel').mockRejectedValue(new FlashActError('ADAPTER_ERROR', 'Cancellation transport lost'));
    try {
      // When
      await expect(engine.armJob('job')).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
      const result = await engine.getResult('job');
      // Then
      expect(result).toMatchObject({ state: 'UNKNOWN', executions: 1 });
    } finally { await Promise.allSettled([engine.close()]); }
  });
  it('reports FAILED when installation fails before any arm command', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job');
    vi.spyOn(adapter, 'installRuntime').mockRejectedValue(new FlashActError('ADAPTER_ERROR', 'Installation rejected'));
    try {
      // When
      await expect(engine.armJob('job')).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
      const result = await engine.getResult('job');
      // Then
      expect(result).toMatchObject({ state: 'FAILED', executions: 0 });
      expect(adapter.statuses.size).toBe(0);
    } finally { await engine.close(); }
  });
  it('retains known dispatch evidence when a cancellation response contradicts the execution count', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job'); await engine.armJob('job');
    adapter.statuses.set('job', { jobId: 'job', state: 'DISPATCHED', executions: 1, updatedAt: 101 });
    try {
      // When
      const result = await engine.cancelJob('job');
      // Then
      expect(result).toMatchObject({ state: 'UNKNOWN', executions: 1 });
    } finally { await engine.close(); }
  });
  it('retains a completed outcome when closing before the host has polled it', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job'); await engine.armJob('job');
    adapter.statuses.set('job', { jobId: 'job', state: 'VERIFIED', executions: 1, updatedAt: 101 });
    // When
    await engine.close();
    // Then
    expect(engine.logs().at(-1)).toMatchObject({ state: 'VERIFIED', executions: 1 });
    expect(adapter.cleanup).toEqual(['disconnect']);
  });
  it('records UNKNOWN and disconnects when shutdown cancellation and status are unreachable', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job'); await engine.armJob('job');
    vi.spyOn(adapter, 'cancel').mockRejectedValue(new FlashActError('ADAPTER_ERROR', 'Cancellation transport lost'));
    vi.spyOn(adapter, 'getStatus').mockRejectedValue(new FlashActError('ADAPTER_ERROR', 'Status transport lost'));
    // When
    await engine.close();
    // Then
    expect(engine.logs().at(-1)?.state).toBe('UNKNOWN');
    expect(adapter.cleanup).toEqual(['disconnect']);
  });
});

describe('MCP SDK client', () => {
  it('enumerates all ten operations when connected', async () => {
    // Given
    const { engine } = fixture(); const server = createMcpServer(engine); const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    try {
      // When
      const result = await client.listTools();
      // Then
      expect(result.tools.map(tool => tool.name).sort()).toEqual([
        'flashact_list_backends', 'flashact_list_tabs', 'flashact_inspect_target', 'flashact_create_job',
        'flashact_validate_job', 'flashact_arm_job', 'flashact_get_status', 'flashact_cancel_job',
        'flashact_get_result', 'flashact_run_benchmark',
      ].sort());
    } finally { await client.close(); await server.close(); await engine.close(); }
  });
  it('validates and arms a plan when using real SDK transport', async () => {
    // Given
    const { engine } = fixture(); const server = createMcpServer(engine); const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    await client.callTool({ name: 'flashact_create_job', arguments: { plan } });
    await client.callTool({ name: 'flashact_validate_job', arguments: { jobId: 'job' } });
    try {
      // When
      const result = await client.callTool({ name: 'flashact_arm_job', arguments: { jobId: 'job' } });
      // Then
      expect(result.isError).not.toBe(true);
      expect((await engine.getStatus('job')).state).toBe('WAITING');
    } finally { await client.close(); await server.close(); await engine.close(); }
  });
  it('returns a tool error when the plan violates the single-shot contract', async () => {
    // Given
    const { engine } = fixture(); const server = createMcpServer(engine); const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    try {
      // When
      const result = await client.callTool({ name: 'flashact_create_job', arguments: { plan: { ...plan, maxExecutions: 2 } } });
      // Then
      expect(result.isError).toBe(true); expect(engine.jobIds()).toEqual([]);
    } finally { await client.close(); await server.close(); await engine.close(); }
  });
});
