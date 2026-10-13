import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';

function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

/** Transparent QA transport. Fault mode withholds actual replies, never fabricates one. */
export function createCdpProxy(endpoint, publish = () => {}) {
  assert(new URL(endpoint).hostname === '127.0.0.1');
  const peers = new Set();
  let nextPeer = 0, mode = null, stopping;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request, instance) {
      return instance.upgrade(request, { data: { id: ++nextPeer } })
        ? undefined : new Response('WebSocket required', { status: 400 });
    },
    websocket: {
      open(socket) {
        const upstream = new WebSocket(endpoint);
        const peer = { id: socket.data.id, socket, upstream, requests: new Map(), waiting: [],
          holding: false, heldIds: new Set(), closed: undefined };
        let closed;
        peer.closed = new Promise(resolve => { closed = resolve; });
        socket.data.peer = peer; peers.add(peer);
        upstream.addEventListener('open', () => {
          for (const value of peer.waiting) upstream.send(value);
          peer.waiting.length = 0;
        });
        upstream.addEventListener('message', event => {
          const text = String(event.data);
          const value = JSON.parse(text);
          const held = (value.id !== undefined && (peer.holding || peer.heldIds.has(value.id)))
            || (peer.holding && mode === 'all-observations-after-wake' && value.method === 'Runtime.consoleAPICalled');
          publish({ event: 'protocol', direction: held ? 'withheld' : 'receive',
            peer: peer.id, at: Date.now(), message: value });
          if (!held) socket.send(text);
        });
        upstream.addEventListener('error', () => {
          publish({ event: 'upstream-error', peer: peer.id }); socket.close();
        });
        upstream.addEventListener('close', () => {
          publish({ event: 'peer-closed', peer: peer.id, at: Date.now() });
          peers.delete(peer); closed(); socket.close();
        });
      },
      message(socket, data) {
        const peer = socket.data.peer;
        const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        const value = JSON.parse(text);
        if (value.id !== undefined) peer.requests.set(value.id, value.method);
        const source = strings(value.params);
        const wake = source.some(value => value.includes('installed.runtime["wake"]('));
        const arm = source.some(value => value.includes('installed.runtime["arm"]('));
        if ((mode === 'all-replies-after-wake' || mode === 'all-observations-after-wake') && wake) peer.holding = true;
        if ((mode === 'wake-reply' && wake) || (mode === 'arm-reply' && arm)) peer.heldIds.add(value.id);
        publish({ event: 'protocol', direction: 'send', peer: peer.id, at: Date.now(),
          wake, arm, message: value });
        if (peer.upstream.readyState === WebSocket.OPEN) peer.upstream.send(text);
        else peer.waiting.push(text);
      },
      close(socket) { socket.data.peer?.upstream.close(); },
    },
  });
  return {
    endpoint: `ws://127.0.0.1:${server.port}`,
    mode(value) {
      assert([null, 'wake-reply', 'arm-reply', 'all-replies-after-wake', 'all-observations-after-wake'].includes(value));
      mode = value;
    },
    close() {
      stopping ??= (async () => {
        const clients = [...peers];
        for (const peer of clients) { peer.socket.close(); peer.upstream.close(); }
        await server.stop(true);
        await Promise.all(clients.map(peer => peer.closed));
        return { closed: true, peers: peers.size, port: server.port };
      })();
      return stopping;
    },
  };
}

if (import.meta.main) {
  const endpoint = process.argv[2];
  assert(endpoint);
  const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  const proxy = createCdpProxy(endpoint, write);
  write({ event: 'ready', endpoint: proxy.endpoint, pid: process.pid });
  const input = createInterface({ input: process.stdin });
  let closing;
  const stop = () => {
    closing ??= proxy.close().then(receipt => { write({ event: 'closed', receipt }); input.close(); process.stdin.pause(); });
    return closing;
  };
  input.on('line', line => {
    const command = JSON.parse(line);
    if (command.command === 'mode') { proxy.mode(command.value); write({ event: 'mode', value: command.value }); }
    else if (command.command === 'close') void stop();
    else throw new Error('Unsupported proxy control command');
  });
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  input.once('close', () => { void stop(); });
}

/** Decode only the exact install expression emitted by this shipped runtime. */
export function capturedPlans(protocol, source, parse) {
  const prefix = `JSON.stringify((${source}).install(`;
  return protocol.filter(item => item.direction === 'send').flatMap(item =>
    strings(item.message.params).filter(value => value.startsWith(prefix)).map(value => {
      assert(value.endsWith('))'), 'Unexpected captured install expression suffix');
      return parse(JSON.parse(value.slice(prefix.length, -2)));
    }));
}
