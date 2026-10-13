import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';

export function barrier<T>() {
  let complete: (value: T) => void = () => undefined;
  const promise = new Promise<T>(resolvePromise => { complete = resolvePromise; });
  return { promise, complete };
}

export async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Missing ${label} barrier`)), 20000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** A real synchronous browser status operation stalls until its producer exits. */
export async function heldStatusFixture() {
  const started = barrier<void>();
  const server = createServer((req, res) => {
    if (req.url === '/held') { started.complete(); res.end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<button id="pending" disabled>pending</button><script>
      let runtime; let armed = false;
      Object.defineProperty(globalThis, '__flashactRuntime', {
        configurable: true, get() { return runtime; }, set(value) {
          runtime = value;
          const arm = runtime.arm; const status = runtime.status;
          runtime.arm = id => { const result = arm(id); armed = true; return result; };
          runtime.status = id => {
            if (armed) { navigator.sendBeacon('/held'); for (;;) {} }
            return status(id);
          };
        }
      });
    </script>`);
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener missing');
  return { url: `http://127.0.0.1:${address.port}/`, started: started.promise,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose()); server.closeAllConnections();
    }) };
}

/** HTTP discovery is accepted but never replied to; no browser is acquired. */
export async function heldConnectFixture() {
  const started = barrier<void>(); const sockets = new Set<Socket>();
  const server = createServer(() => started.complete());
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener missing');
  return { endpoint: `http://127.0.0.1:${address.port}`, started: started.promise,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose());
      for (const socket of sockets) socket.destroy();
    }) };
}

export function serviceChild(args: readonly string[], home: string) {
  const child = spawn(process.execPath, [resolve('dist/cli/index.js'), ...args],
    { env: { ...process.env, FLASHACT_HOME: home } });
  const exited = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  let stdout = ''; let stderr = ''; let buffer = '';
  const messages: unknown[] = [];
  const listeners = new Set<(value: unknown) => void>();
  const replies = new Map<number, (value: unknown) => void>();
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString(); buffer += chunk.toString();
    const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
    for (const line of lines) {
      const value: unknown = JSON.parse(line); messages.push(value);
      for (const listener of listeners) listener(value);
      const response = z.object({ id: z.number() }).safeParse(value);
      if (response.success) { replies.get(response.data.id)?.(value); replies.delete(response.data.id); }
    }
  });
  let id = 0;
  const send = (method: string, params: unknown = {}) => {
    const requestId = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    return requestId;
  };
  const request = async (method: string, params: unknown = {}): Promise<unknown> => {
    // Response handlers are registered before writing, not after a timing delay.
    const requestId = id + 1;
    const reply = new Promise<unknown>(resolveReply => replies.set(requestId, resolveReply));
    send(method, params);
    return bounded(reply, `${method} reply`);
  };
  return { child, exited, messages, output: () => ({ stdout, stderr }), send, request,
    waitForState: async (state: string) => {
      const matches = (value: unknown) => {
        const status = z.object({ state: z.string() }).safeParse(value);
        return status.success && status.data.state === state;
      };
      const previous = messages.find(matches);
      if (previous !== undefined) return previous;
      const next = barrier<unknown>();
      const listener = (value: unknown) => { if (matches(value)) next.complete(value); };
      listeners.add(listener);
      try { return await bounded(next.promise, `${state} status`); }
      finally { listeners.delete(listener); }
    },
    initialize: async () => {
      await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lifecycle', version: '1' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await bounded(exited, 'service child exit');
    } };
}

export function toolValue(value: unknown): unknown {
  const reply = z.object({ result: z.object({ isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })) }) }).parse(value);
  if (reply.result.isError) throw new Error(`Tool failed: ${JSON.stringify(reply.result.content)}`);
  const content = reply.result.content[0];
  if (!content) throw new Error('Tool returned no text');
  const decoded: unknown = JSON.parse(content.text);
  return decoded;
}
