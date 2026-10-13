import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { closeOwnedTransport, commitProbeOutput, joinOwnedChild, recordProbeStop } from '../../scripts/controlled-hidden-probe.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

describe('controlled probe exact-child stdio join', () => {
  it('joins close promptly after root exit even when an owned helper inherits stderr', async () => {
    // Pass the root's actual stderr write end over IPC, so the test can spawn
    // and join the extra writer itself instead of orphaning a grandchild.
    const source = `process.on('message', () => process.exit(0));
      process.send('stderr', process.stderr, { keepOpen: true });`;
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let helper, writeEnd, helperClosed;
    const receipts = [];
    child.stderr.resume();
    const exited = once(child, 'exit');
    const close = joinOwnedChild(child, {
      onExit: receipt => receipts.push({ event: 'exit', ...receipt }),
      onClose: receipt => receipts.push({ event: 'close', ...receipt }),
    });
    try {
      const [message, handle] = await once(child, 'message', { signal: AbortSignal.timeout(3000) });
      expect(message).toBe('stderr');
      writeEnd = handle;
      helper = spawn(process.execPath, ['-e',
        `process.on('message', () => process.exit(0)); process.send('ready');`],
      { stdio: ['ignore', 'ignore', writeEnd, 'ipc'] });
      helperClosed = once(helper, 'close');
      await once(helper, 'message', { signal: AbortSignal.timeout(3000) });
      writeEnd.destroy();
      const closed = once(child, 'close', { signal: AbortSignal.timeout(3000) });
      child.send('exit');
      expect(await exited).toEqual([0, null]);
      await closed;
      // The helper still holds the write end after the root's close.
      process.kill(helper.pid, 0);
      expect(await close).toEqual({ code: 0, signal: null });
      expect(receipts).toEqual([{ event: 'exit', code: 0, signal: null }, { event: 'close', code: 0, signal: null }]);
    } finally {
      writeEnd?.destroy();
      if (helper) {
        if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGTERM');
        await helperClosed;
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      child.stderr.destroy();
      await close;
    }
  });
});

describe('controlled probe transport and final commit seams (not native gates)', () => {
  it('finishes session and page cleanup before disconnecting a healthy transport', async () => {
    const detach = deferred(), started = deferred(), calls = [], closures = new Map();
    let detached = false, disconnectedEarly = false;
    const close = (name, resource, dispose, predecessors = []) => {
      if (!resource || closures.has(name)) return closures.get(name);
      const promise = Promise.all(predecessors).then(() => dispose(resource));
      closures.set(name, promise);
      return promise;
    };
    closeOwnedTransport(close, {
      pageCDP: { detach: async () => {
        calls.push('detach-start'); started.resolve();
        await detach.promise;
        detached = true; calls.push('detach-finished');
      } },
      page: { close: async () => { calls.push('page'); } },
      browser: { close: async () => {
        disconnectedEarly = !detached;
        calls.push('disconnect');
      } },
    });
    await started.promise;
    detach.resolve();
    await Promise.all(closures.values());
    expect(disconnectedEarly, 'Disconnect must not orphan a pending child detach').toBe(false);
    expect(calls).toEqual(['detach-start', 'detach-finished', 'page', 'disconnect']);
  });

  it('memoizes and joins cleanup failures before disconnect', async () => {
    const detach = deferred(), calls = [], closures = new Map(), failures = [];
    const close = (name, resource, dispose, predecessors = []) => {
      if (!resource || closures.has(name)) return closures.get(name);
      const promise = Promise.all(predecessors).then(() => dispose(resource))
        .catch(error => failures.push({ name, message: error.message }));
      closures.set(name, promise);
      return promise;
    };
    const resources = {
      pageCDP: { detach: () => {
        calls.push('detach'); detach.reject(new Error('detach failed')); return detach.promise;
      } },
      page: { close: async () => { calls.push('page'); } },
      browser: { close: async () => { calls.push('disconnect'); } },
    };
    closeOwnedTransport(close, resources);
    closeOwnedTransport(close, resources);
    await Promise.all(closures.values());
    expect(calls).toEqual(['detach', 'page', 'disconnect']);
    expect(failures).toEqual([{ name: 'pageCDP', message: 'detach failed' }]);
    expect(closures.size).toBe(3);
  });

  it.each([false, true])('retires stops before writing, joins write and close (precommit stop=%s)', async acceptedStop => {
    // A success sentinel exercises persistence only, never fabricates native evidence.
    const report = { status: 'HIDDEN_GATE_VERIFIED', lifecycle: { stopReason: null } };
    const signals = new EventEmitter(), write = deferred(), close = deferred();
    const handler = () => recordProbeStop(report, 'SIGTERM');
    signals.on('SIGTERM', handler);
    if (acceptedStop) {
      signals.emit('SIGTERM');
      expect(report.status).toBe('BLOCKED'); // synchronous demotion
      expect(recordProbeStop(report, 'second-stop')).toBe(false);
    }
    const closeSignal = deferred();
    let persisted, closeStarted = false, finished = false;
    const finalization = commitProbeOutput(report, {
      write: value => { persisted = structuredClone(value); return write.promise; },
      close: () => { closeStarted = true; closeSignal.resolve(); return close.promise; },
    }, () => signals.removeListener('SIGTERM', handler)).then(() => { finished = true; });
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    signals.emit('SIGTERM'); // during write: no longer an accepted stop
    expect(closeStarted).toBe(false);
    write.resolve();
    await closeSignal.promise;
    expect(closeStarted).toBe(true);
    expect(finished).toBe(false);
    signals.emit('SIGTERM'); // former B3 window: close is pending
    close.resolve();
    await finalization;
    expect(persisted).toEqual(report);
    expect(report.status).toBe(acceptedStop ? 'BLOCKED' : 'HIDDEN_GATE_VERIFIED');
    expect(report.lifecycle.stopReason).toBe(acceptedStop ? 'SIGTERM' : null);
  });

  it('joins output close and rejects if the final write fails', async () => {
    const close = deferred();
    const closeSignal = deferred();
    let closed = false;
    const finalization = commitProbeOutput({}, {
      write: async () => { throw new Error('write failed'); },
      close: () => { closed = true; closeSignal.resolve(); return close.promise; },
    }, () => {});
    const rejected = expect(finalization).rejects.toThrow('write failed');
    await closeSignal.promise;
    expect(closed).toBe(true);
    close.resolve();
    await rejected;
  });
});
