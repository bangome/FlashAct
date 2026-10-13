import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request } from 'node:http';
import { open, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { JobEngine } from '../core/engine.js';
import { FlashActError } from '../utils/errors.js';
import { checkPrivate, privateHome } from './privacy.js';

const metadataSchema = z.strictObject({ port: z.number().int().min(1).max(65535), token: z.string().regex(/^[a-f0-9]{64}$/), pid: z.number().int().positive() });
export type ControlRequest = { readonly command: 'status' | 'cancel' | 'logs'; readonly jobId?: string };
export const controlHome = () => process.env['FLASHACT_HOME'] ?? join(homedir(), '.flashact');

export async function startControlServer(engine: JobEngine, home = controlHome()) {
  await privateHome(home);
  const path = join(home, 'engine.json');
  let lock;
  try { lock = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new FlashActError('INVALID_STATE', 'An engine owns this home. If it crashed, remove its stale engine.json manually.');
    throw error;
  }
  const token = randomBytes(32).toString('hex');
  const server = createServer((req, res) => {
    const received = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.socket.remoteAddress !== '127.0.0.1' || received.length !== expected.length || !timingSafeEqual(received, expected)) {
      res.writeHead(401).end(); return;
    }
    const handle = async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const id = url.searchParams.get('jobId');
      let result: unknown;
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /status': result = id ? await engine.getStatus(id) : await Promise.all(engine.jobIds().map(jobId => engine.getStatus(jobId))); break;
        case 'GET /logs': result = engine.logs(); break;
        case 'POST /cancel':
          if (!id) throw new FlashActError('INVALID_PLAN', 'Job ID is required');
          result = await engine.cancelJob(id); break;
        default: res.writeHead(404).end(); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(result));
    };
    void handle().catch(error => {
      // HTTP boundary returns error codes only, never adapter exception payloads.
      const code = error instanceof FlashActError ? error.code : 'INTERNAL_ERROR';
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: code }));
    });
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      if (server.listening) await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections();
      });
      await lock.close();
      await unlink(path);
    })();
    return closed;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new FlashActError('INTERNAL_ERROR', 'IPC port unavailable');
    const metadata = { port: address.port, token, pid: process.pid };
    await lock.writeFile(JSON.stringify(metadata));
    await lock.sync();
    return { close, port: address.port };
  } catch (error) { await close(); throw error; }
}

export async function sendControl(input: ControlRequest, home = controlHome()): Promise<unknown> {
  await checkPrivate(home, true);
  const path = join(home, 'engine.json');
  await checkPrivate(path);
  const decoded: unknown = JSON.parse(await readFile(path, 'utf8'));
  const metadata = metadataSchema.parse(decoded);
  const query = input.jobId ? `?jobId=${encodeURIComponent(input.jobId)}` : '';
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: metadata.port, path: `/${input.command}${query}`,
      method: input.command === 'cancel' ? 'POST' : 'GET', headers: { Authorization: `Bearer ${metadata.token}` }, timeout: 5000 }, res => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1_048_576) { req.destroy(new FlashActError('INVALID_RESPONSE', 'IPC response too large')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new FlashActError('INVALID_RESPONSE', `IPC request failed (${res.statusCode})`)); return; }
        try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(value); }
        catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new FlashActError('ADAPTER_ERROR', 'IPC timeout')));
    req.on('error', reject); req.end();
  });
}
