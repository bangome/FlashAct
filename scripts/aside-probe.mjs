import { createServer } from 'node:http';

// Task-owned fixture. No cookies, external requests, or persistent browser storage.
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Aside lifecycle fixture</title></head>
<body><h1>Aside lifecycle fixture</h1>
<button id="reserve" data-state="initial">Reserve fixture</button>
<output id="click-count">Clicks: 0</output>
<a id="navigate" href="/next">Navigate fixture</a>
<script>
window.fixtureLedger = [];
window.fixtureClicks = 0;
window.fixtureBoot = { timeOrigin: performance.timeOrigin, wallMs: Date.now() };
document.querySelector('#reserve').addEventListener('click', () => {
  window.fixtureClicks += 1;
  const entry = { event: 'fixture-click', nowMs: performance.now(), wallMs: Date.now(), count: window.fixtureClicks };
  window.fixtureLedger.push(entry);
  document.querySelector('#click-count').textContent = 'Clicks: ' + window.fixtureClicks;
});
</script></body></html>`;

const server = createServer((request, response) => {
  const route = request.url;
  console.log('PROBE_SERVER ' + JSON.stringify({ event: 'request', route, wallMs: Date.now() }));
  if (route === '/' || route === '/next') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
    return;
  }
  response.writeHead(404);
  response.end('Not found');
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP listener');
  console.log('PROBE_SERVER ' + JSON.stringify({ event: 'ready', pid: process.pid, host: address.address, port: address.port, url: `http://127.0.0.1:${address.port}/`, wallMs: Date.now() }));
});

process.once('SIGTERM', () => {
  server.close(() => {
    console.log('PROBE_SERVER ' + JSON.stringify({ event: 'closed', pid: process.pid, wallMs: Date.now() }));
  });
  server.closeIdleConnections();
});
