import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

const childSessionId = 'controlled-browser-child';
const fixture = new URL('../fixtures/controlled-probe-sdk-repro.mjs', import.meta.url);

async function receive(worker, type, command) {
  // Deadline only fails a missing event; it never decides that detach is
  // pending. Subscribe before the command so no fast response can be missed.
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 10_000);
  try {
    const message = once(worker, 'message', { signal: abort.signal });
    if (command) worker.postMessage({ type: command });
    const [receipt] = await message;
    if (receipt.type === 'failure') throw new Error(receipt.error);
    expect(receipt.type).toBe(type);
    return receipt;
  } finally {
    clearTimeout(deadline);
  }
}

describe('installed SDK public CDP detach on transport disconnect (no Chrome)', () => {
  it.each([false, true])(
    'observes child resume acknowledgement=%s and terminates/joins its SDK worker',
    async acknowledgeFirst => {
      const worker = new Worker(fixture, { workerData: { acknowledgeFirst } });
      const exited = new Promise(resolve => worker.once('exit', resolve));
      let evidence;
      try {
        const ready = await receive(worker, 'ready');
        expect(ready.sdkVersion).toBe('1.64.0');
        expect(ready.browserConnected).toBe(true);
        expect(ready.outstanding).toEqual([]);
        expect(ready.detachState).toBe('not-started');

        const resume = await receive(worker, 'resume-held', 'detach');
        expect(resume.request).toEqual({
          id: 6, method: 'Runtime.runIfWaitingForDebugger',
          params: undefined, sessionId: childSessionId,
        });
        if (acknowledgeFirst) {
          const parent = await receive(worker, 'parent-detach-held', 'acknowledge');
          expect(parent.request).toEqual({
            id: 7, method: 'Target.detachFromTarget',
            params: { sessionId: childSessionId },
          });
        }

        const disconnected = await receive(worker, 'disconnected', 'disconnect');
        expect(disconnected.closed).toBe(true);
        expect(disconnected.browserConnected).toBe(false);
        // A new parent->worker message task after the public disconnected
        // event AND the post-disconnect public RPC rejection is the exact
        // observation boundary. No sleep, polling, or Promise.race timeout.
        evidence = await receive(worker, 'checkpoint', 'checkpoint');
        expect(evidence.events).toContain('browser.disconnected');
        expect(evidence.events).toContain('post-disconnect-api.rejected');
        expect(evidence.events.at(-1)).toBe('parent.checkpoint');
        expect(evidence.detachState).toBe(acknowledgeFirst ? 'rejected' : 'pending');
        expect(disconnected.detachState).toBe(evidence.detachState);
        if (acknowledgeFirst) {
          expect(evidence.detachError).toMatch(/closed/i);
          expect(evidence.events).toContain('detach.rejected');
        } else {
          expect(evidence.detachError).toBeUndefined();
          expect(evidence.events).not.toContain('detach.rejected');
          expect(evidence.events).not.toContain('detach.fulfilled');
        }

        expect(evidence.requests.map(({ id, method, sessionId }) =>
          ({ id, method, sessionId }))).toEqual([
          { id: 1, method: 'Browser.getVersion', sessionId: undefined },
          { id: 2, method: 'Target.setAutoAttach', sessionId: undefined },
          { id: 3, method: 'Target.getTargetInfo', sessionId: undefined },
          { id: 4, method: 'Target.attachToBrowserTarget', sessionId: undefined },
          { id: 5, method: 'Browser.getVersion', sessionId: childSessionId },
          { id: 6, method: 'Runtime.runIfWaitingForDebugger', sessionId: childSessionId },
          ...(acknowledgeFirst
            ? [{ id: 7, method: 'Target.detachFromTarget', sessionId: undefined }] : []),
        ]);
        expect(evidence.responses.map(({ id }) => id))
          .toEqual(acknowledgeFirst ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5]);
        // "Outstanding" is the recording transport's unanswered requests,
        // not an assertion about private SDK callback maps.
        expect(evidence.outstanding).toEqual([
          acknowledgeFirst
            ? { id: 7, method: 'Target.detachFromTarget', params: { sessionId: childSessionId } }
            : resume.request,
        ]);
      } finally {
        // Termination cancels the entire SDK owner, not just a racing waiter.
        // Join even when an assertion or worker initialization fails.
        const terminationCode = await worker.terminate();
        const exitCode = await exited;
        expect(exitCode).toBe(terminationCode);
        expect(worker.threadId).toBe(-1);
        if (evidence) {
          console.info('controlled-probe-sdk-evidence', JSON.stringify({
            ...evidence, workerJoined: true, workerExitCode: exitCode,
          }));
        }
      }
    },
    20_000,
  );
});
