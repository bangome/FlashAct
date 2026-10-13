import { Worker } from 'node:worker_threads';

// The caller owns real termination of operation() once it starts. Aborting the
// timer must never pretend to cancel an already-started SDK producer.
export async function scheduleProbeOperation(scheduler, at, signal, operation) {
  let cancel = () => {}, started = false, rejectPending;
  const abort = () => { cancel(); if (!started) rejectPending(signal.reason); };
  try {
    return await new Promise((resolve, reject) => {
      rejectPending = reject;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      cancel = scheduler.schedule(at, () => {
        started = true;
        const hostDispatchWallMs = Date.now();
        void operation().then(value => resolve({ value, hostDispatchWallMs }), reject);
      });
    });
  } finally { cancel(); signal.removeEventListener('abort', abort); }
}

// Only SDK operations live in the worker. Chrome, its profile, the fixture and
// the report remain owned by the caller, even when an SDK RPC never settles.
export function createProbeDriver({
  workerURL = new URL('./controlled-probe-worker.mjs', import.meta.url),
  workerData,
  onProtocol = () => {},
  onExit = () => {},
} = {}) {
  const worker = new Worker(workerURL, { workerData });
  const pending = new Map();
  let nextId = 0, stopping = false, exited = false, cancellation, workerError;
  let resolveExit;
  const joined = new Promise(resolve => { resolveExit = resolve; });
  worker.on('message', message => {
    if (message.type === 'protocol') {
      onProtocol(message.record);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.value);
  });
  worker.on('error', error => { workerError = error; });
  worker.once('exit', code => {
    exited = true;
    const receipt = { code, cancelled: stopping, error: workerError?.message ?? null };
    // Exit is the cancellation boundary. No producer survives this rejection.
    for (const request of pending.values()) request.reject(workerError ?? new Error('Owned SDK driver exited'));
    pending.clear();
    onExit(receipt);
    resolveExit(receipt);
  });
  return {
    invoke(command, args = []) {
      if (stopping || exited) return Promise.reject(new Error('Owned SDK driver is stopped'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, command, args });
      });
    },
    cancel() {
      if (cancellation) return cancellation;
      stopping = true;
      cancellation = (async () => {
        if (!exited) await worker.terminate();
        return await joined;
      })();
      return cancellation;
    },
    get stopped() { return stopping || exited; },
    joined,
  };
}
