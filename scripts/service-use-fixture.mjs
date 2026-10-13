import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { z } from 'zod';

const actionSchema = z.strictObject({
  token: z.string(),
  clickEpochMs: z.number().finite().nonnegative(),
  clickWallEpochMs: z.number().int().nonnegative(),
  hidden: z.boolean(),
  url: z.url(),
});

function page(token, options) {
  return `<!doctype html><meta charset="utf-8"><title>FlashAct receipt ${token}</title>
<h1>Local service acceptance</h1><p id="case">${token}</p><div id="target"></div><div id="result"></div>
<script>
(() => {
  const token = ${JSON.stringify(token)};
  const options = ${JSON.stringify(options)};
  const clicks = [], audit = [];
  document.addEventListener('visibilitychange', event => audit.push({
    hidden: document.hidden, visibilityState: document.visibilityState,
    trusted: event.isTrusted, epochMs: Date.now()
  }));
  const appear = () => {
    const button = document.createElement('button');
    button.id = 'action'; button.textContent = 'Send one local request';
    button.disabled = !options.enabled; button.type = options.irreversible ? 'submit' : 'button';
    const root = options.irreversible ? document.createElement('form') : document.getElementById('target');
    if (options.irreversible) document.getElementById('target').append(root);
    root.append(button);
    button.addEventListener('click', async event => {
      event.preventDefault();
      const action = { token, clickEpochMs: performance.timeOrigin + performance.now(),
        clickWallEpochMs: Date.now(), hidden: document.hidden, url: location.href };
      clicks.push(action);
      try {
        const response = await fetch('/accept/' + token, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action)
        });
        const receipt = await response.json();
        const output = document.createElement('output');
        if (receipt.accepted) output.dataset.ack = token;
        else output.dataset.rejected = token;
        output.textContent = JSON.stringify(receipt);
        document.getElementById('result').append(output);
      } catch (error) {
        const output = document.createElement('output'); output.dataset.failed = token;
        output.textContent = String(error); document.getElementById('result').append(output);
      }
    });
  };
  if (options.present) appear();
  window.__serviceFixture = {
    appear,
    enable: () => { document.getElementById('action').disabled = false; },
    snapshot: () => ({ token, clicks: [...clicks], audit: [...audit], hidden: document.hidden,
      visibilityState: document.visibilityState, url: location.href })
  };
})();
</script>`;
}

/** Authored local application: receipts are independent of the automation engine. */
export async function createServiceFixture() {
  const cases = new Map();
  const attempts = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const token = /^\/(?:task|accept)\/([a-zA-Z0-9_-]+)$/.exec(path)?.[1];
    const item = token ? cases.get(token) : undefined;
    if (!item) { response.writeHead(404).end(); return; }
    if (request.method === 'GET' && path.startsWith('/task/')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(page(token, item.options)); return;
    }
    if (request.method !== 'POST' || !path.startsWith('/accept/')) { response.writeHead(405).end(); return; }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      let decoded;
      try { decoded = JSON.parse(body); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        response.writeHead(400).end(); return;
      }
      const parsed = actionSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.token !== token || parsed.data.url !== item.url) {
        response.writeHead(400).end(); return;
      }
      const receivedEpochMs = Date.now();
      const duplicate = item.receipts.length > 0;
      const early = receivedEpochMs < item.options.at || parsed.data.clickWallEpochMs < item.options.at;
      const receipt = { ...parsed.data, receivedEpochMs, duplicate, early, accepted: !duplicate && !early };
      attempts.push(receipt); item.receipts.push(receipt); item.received(receipt);
      response.writeHead(receipt.accepted ? 200 : 409, { 'content-type': 'application/json' });
      response.end(JSON.stringify(receipt));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let closing;
  return {
    baseUrl, port: address.port, attempts,
    register(token, input = {}) {
      assert(/^[a-zA-Z0-9_-]+$/.test(token) && !cases.has(token));
      const options = { at: 0, enabled: true, present: true, irreversible: false, ...input };
      let received;
      const receipt = new Promise(resolve => { received = resolve; });
      const item = { options, url: `${baseUrl}/task/${token}`, receipts: [], received, receipt };
      cases.set(token, item);
      return { token, url: item.url, selector: '#action', ack: `[data-ack="${token}"]`,
        receipt, receipts: item.receipts };
    },
    close() {
      closing ??= new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve({ port: address.port, closed: !server.listening }));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
