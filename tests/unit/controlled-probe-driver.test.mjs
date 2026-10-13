import { describe, expect, it } from 'vitest';
import { createProbeDriver, scheduleProbeOperation } from '../../scripts/controlled-probe-driver.mjs';

const workerURL = new URL('../fixtures/controlled-probe-driver-fixture.mjs', import.meta.url);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

describe('owned SDK driver cancellation boundary', () => {
  it('joins normal replies and the final worker exit', async () => {
    const driver = createProbeDriver({ workerURL });
    try {
      expect(await driver.invoke('echo', ['receipt'])).toBe('receipt');
      const receipt = await driver.cancel();
      expect(receipt.cancelled).toBe(true);
      expect(await driver.joined).toEqual(receipt);
      expect(await driver.cancel()).toBe(receipt);
    } finally { await driver.cancel(); }
  });

  it.each(['evaluate', 'late-acquisition'])('rejects held %s only after the producer worker has exited', async operation => {
    const held = deferred(), events = [];
    const driver = createProbeDriver({
      workerURL,
      onProtocol: record => { if (record.event === 'held') held.resolve(); },
      onExit: () => events.push('exit'),
    });
    const request = driver.invoke('hold', [operation]);
    const rejected = request.catch(error => { events.push('rejected'); return error.message; });
    try {
      await held.promise;
      const termination = driver.cancel();
      expect(await rejected).toBe('Owned SDK driver exited');
      await termination;
      expect(events).toEqual(['exit', 'rejected']);
      await expect(driver.invoke('echo')).rejects.toThrow('stopped');
    } finally { await driver.cancel(); }
  });

  it('accepts a late acquisition before normal shutdown, without losing its reply', async () => {
    const held = deferred();
    const driver = createProbeDriver({
      workerURL, onProtocol: record => { if (record.event === 'held') held.resolve(); },
    });
    try {
      const acquisition = driver.invoke('hold');
      await held.promise;
      expect(await driver.invoke('release')).toBe('released');
      expect(await acquisition).toBe('acquired');
    } finally { await driver.cancel(); }
  });
});

const manualScheduler = () => {
  let callback, active = false, scheduled = 0;
  return {
    schedule(_at, operation) { scheduled++; active = true; callback = operation; return () => { active = false; }; },
    fire() { if (active) { active = false; callback(); } },
    get active() { return active; }, get scheduled() { return scheduled; },
  };
};

describe('owned probe host deadline', () => {
  it('cancels before firing without starting a producer', async () => {
    const scheduler = manualScheduler(), stop = new AbortController();
    let calls = 0;
    const request = scheduleProbeOperation(scheduler, 1, stop.signal, async () => { calls++; });
    const rejected = request.catch(value => value);
    stop.abort(new Error('stop'));
    scheduler.fire();
    expect(await rejected).toBeInstanceOf(Error);
    expect(calls).toBe(0);
    expect(scheduler.active).toBe(false);
  });

  it('does not schedule after an already accepted stop', async () => {
    const scheduler = manualScheduler(), stop = new AbortController();
    stop.abort(new Error('stop'));
    await expect(scheduleProbeOperation(scheduler, 1, stop.signal, async () => {})).rejects.toBeInstanceOf(Error);
    expect(scheduler.scheduled).toBe(0);
  });

  it('returns a single completed producer and retires its timer', async () => {
    const scheduler = manualScheduler(), stop = new AbortController();
    let calls = 0;
    const request = scheduleProbeOperation(scheduler, 1, stop.signal, async () => { calls++; return 'receipt'; });
    scheduler.fire(); scheduler.fire();
    expect((await request).value).toBe('receipt');
    expect(calls).toBe(1);
    expect(scheduler.active).toBe(false);
  });

  it('joins a started held SDK producer before reporting cancellation', async () => {
    const held = deferred(), scheduler = manualScheduler(), stop = new AbortController(), events = [];
    const driver = createProbeDriver({ workerURL,
      onProtocol: record => { if (record.event === 'held') held.resolve(); },
      onExit: () => events.push('exit') });
    const request = scheduleProbeOperation(scheduler, 1, stop.signal, () => driver.invoke('hold'));
    const rejected = request.catch(value => { events.push('rejected'); return value; });
    try {
      scheduler.fire();
      await held.promise;
      stop.abort(new Error('stop'));
      expect(events).toEqual([]);
      const shutdown = driver.cancel();
      expect(await rejected).toBeInstanceOf(Error);
      await shutdown;
      expect(events).toEqual(['exit', 'rejected']);
      expect(scheduler.active).toBe(false);
    } finally { await driver.cancel(); }
  });
});
