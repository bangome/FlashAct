import { parentPort } from 'node:worker_threads';

// Explicit acknowledgments are the test clock; no browser or external resource.
const pending = new Map();
parentPort.on('message', ({ id, command, args }) => {
  if (command === 'hold') {
    pending.set(id, args);
    parentPort.postMessage({ type: 'protocol', record: { event: 'held', id } });
  } else if (command === 'release') {
    for (const requestId of pending.keys()) parentPort.postMessage({ id: requestId, value: 'acquired' });
    pending.clear();
    parentPort.postMessage({ id, value: 'released' });
  } else {
    parentPort.postMessage({ id, value: args[0] });
  }
});
