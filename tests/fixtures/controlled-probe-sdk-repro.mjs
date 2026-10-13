import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import { chromium } from 'playwright';

// This fixture must live in a test-owned worker: disconnect does not cancel the
// pending SDK operation, and terminating/joining the worker is the cleanup.
assert(parentPort, 'Run the reproduction in a test-owned worker thread');
const require = createRequire(import.meta.url);
const sdkVersion = require('playwright-core/package.json').version;
assert.equal(sdkVersion, '1.64.0');

const childSessionId = 'controlled-browser-child';
const version = {
  protocolVersion: '1.3',
  product: 'Chrome/164.0.0.0',
  revision: 'controlled-no-chrome',
  userAgent: 'controlled-no-chrome',
  jsVersion: 'controlled',
};
const requests = [];
const responses = [];
const outstanding = new Map();
const events = [];
let closed = false;
let heldRequest;
let detachState = 'not-started';
let detachError;
let detachObserved;
let browser;
let session;

function reply(request, result) {
  assert.equal(closed, false, 'No responses may be fabricated after disconnect');
  assert.equal(outstanding.get(request.id), request);
  const response = { id: request.id, result };
  if (request.sessionId) response.sessionId = request.sessionId;
  outstanding.delete(request.id);
  responses.push(response);
  transport.onmessage(response);
}

// The public transport receives objects, not JSON strings. Respond on a
// microtask so CRSession.send has installed the callback for this exact ID.
const transport = {
  send(message) {
    assert.equal(closed, false);
    const request = structuredClone(message);
    requests.push(request);
    outstanding.set(request.id, request);
    queueMicrotask(() => {
      switch (request.method) {
        case 'Browser.getVersion':
          reply(request, version);
          break;
        case 'Target.setAutoAttach':
          assert.deepEqual(request.params, {
            autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
          });
          reply(request, {});
          break;
        case 'Target.getTargetInfo':
          reply(request, {
            targetInfo: {
              targetId: 'controlled-browser', type: 'browser', title: '',
              url: '', attached: true, canAccessOpener: false,
            },
          });
          break;
        case 'Target.attachToBrowserTarget':
          reply(request, { sessionId: childSessionId });
          break;
        case 'Runtime.runIfWaitingForDebugger':
          assert.equal(request.sessionId, childSessionId);
          assert.equal(heldRequest, undefined, 'Withhold the first child resume');
          heldRequest = request;
          parentPort.postMessage({ type: 'resume-held', request });
          break;
        case 'Target.detachFromTarget':
          assert.equal(request.sessionId, undefined);
          assert.deepEqual(request.params, { sessionId: childSessionId });
          heldRequest = request;
          parentPort.postMessage({ type: 'parent-detach-held', request });
          break;
        default:
          throw new Error(`Unexpected SDK request: ${JSON.stringify(request)}`);
      }
    });
  },
  close() {
    assert.equal(closed, false, 'Disconnect the transport exactly once');
    closed = true;
    events.push('transport.close');
    // No Target.detachedFromTarget event, child disposal, or promise rejection
    // is synthesized. Only the installed SDK handles this close notification.
    transport.onclose('controlled transport disconnect');
  },
};

function snapshot(type) {
  return {
    type, sdkVersion, nodeVersion: process.version,
    acknowledgeFirst: workerData.acknowledgeFirst,
    browserConnected: browser.isConnected(),
    detachState, detachError, closed,
    requests, responses, outstanding: [...outstanding.values()], events,
  };
}

async function command({ type }) {
  switch (type) {
    case 'detach':
      assert.equal(detachState, 'not-started');
      detachState = 'pending';
      detachObserved = session.detach().then(
        () => { detachState = 'fulfilled'; events.push('detach.fulfilled'); },
        error => {
          detachState = 'rejected';
          detachError = error.message;
          events.push('detach.rejected');
        },
      );
      break;
    case 'acknowledge':
      assert.equal(workerData.acknowledgeFirst, true);
      assert.equal(heldRequest.method, 'Runtime.runIfWaitingForDebugger');
      reply(heldRequest, {});
      break;
    case 'disconnect': {
      assert.equal(heldRequest.method, workerData.acknowledgeFirst
        ? 'Target.detachFromTarget' : 'Runtime.runIfWaitingForDebugger');
      const disconnected = once(browser, 'disconnected');
      transport.close();
      await disconnected;
      events.push('browser.disconnected');
      // An actual public RPC after disposal is a positive barrier: the SDK
      // must process it and reject it, rather than a timer "proving" absence.
      await assert.rejects(browser.newBrowserCDPSession(), error => {
        events.push('post-disconnect-api.rejected');
        return /closed/i.test(error.message);
      });
      if (workerData.acknowledgeFirst) await detachObserved;
      parentPort.postMessage(snapshot('disconnected'));
      break;
    }
    case 'checkpoint':
      assert.equal(closed, true);
      assert(events.includes('post-disconnect-api.rejected'));
      // Parent sends this only after receiving "disconnected". This new
      // message task follows that SDK barrier and its microtask checkpoint.
      events.push('parent.checkpoint');
      parentPort.postMessage(snapshot('checkpoint'));
      break;
    default:
      throw new Error(`Unexpected test command: ${type}`);
  }
}

try {
  // Supply an existing directory to avoid Playwright's automatic artifacts
  // temp directory. No browser, server, socket, or profile is created.
  browser = await chromium.connectOverCDP(transport, {
    noDefaults: true,
    artifactsDir: fileURLToPath(new URL('.', import.meta.url)),
  });
  assert.equal(browser.contexts().length, 1);
  assert.equal(browser.contexts()[0].pages().length, 0);
  session = await browser.newBrowserCDPSession();
  assert.deepEqual(await session.send('Browser.getVersion'), version);
  parentPort.on('message', message => {
    command(message).catch(error => {
      parentPort.postMessage({ type: 'failure', error: error.stack });
    });
  });
  parentPort.postMessage(snapshot('ready'));
} catch (error) {
  parentPort.postMessage({ type: 'failure', error: error.stack });
}
