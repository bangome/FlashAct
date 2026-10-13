import { parentPort, workerData } from 'node:worker_threads';

// The real Chrome response arrives, but never reaches the actual SDK. Holding a
// response does not reject the SDK promise; only joined worker exit cancels it.
const NativeWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends NativeWebSocket {
  heldId;
  send(data) {
    const message = JSON.parse(data);
    if (!this.heldId && message.method === workerData.method
      && (!workerData.expressionPrefix || message.params?.expression?.startsWith(workerData.expressionPrefix))) {
      this.heldId = message.id;
    }
    super.send(data);
  }
  addEventListener(type, listener, options) {
    if (type !== 'message') return super.addEventListener(type, listener, options);
    return super.addEventListener(type, event => {
      const message = JSON.parse(event.data);
      if (this.heldId !== undefined && message.id === this.heldId) {
        parentPort.postMessage({
          type: 'protocol',
          record: { direction: 'withheld', at: new Date().toISOString(),
            id: message.id, method: workerData.method, sessionId: message.sessionId },
        });
      } else listener(event);
    }, options);
  }
};
await import('../../scripts/controlled-probe-worker.mjs');
