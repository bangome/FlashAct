import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import type { JobStatus } from '../../src/core/types.js';
import { JobEngine } from '../../src/core/engine.js';
import { sendControl, startControlServer } from '../../src/cli/ipc.js';

const homes: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'flashact-control-')); homes.push(home);
  const engine = new JobEngine();
  await engine.createJob({ schemaVersion: '1.0', jobId: 'draft', name: 'draft', backend: 'aside',
    target: { tabId: 'existing', selector: '#button', url: 'https://example.test/' },
    trigger: { type: 'ELEMENT_ENABLE', selector: '#button' }, action: { type: 'click' }, timezone: 'UTC',
    expiresAt: Date.now() + 60000, maxExecutions: 1, verification: { timeoutMs: 100 },
    guards: { approvedUrl: 'https://example.test/', allowIrreversible: false } });
  const control = await startControlServer(engine, home);
  return { home, engine, control };
}

describe('private loopback IPC', () => {
  it('admits cancellation alongside a held status and drains that handler before removing its lock', async () => {
    // Given
    const { home, engine, control } = await fixture();
    const getStatus = engine.getStatus.bind(engine);
    let started: () => void = () => undefined;
    const statusStarted = new Promise<void>(resolve => { started = resolve; });
    let release: (status: JobStatus) => void = () => undefined;
    const released = new Promise<JobStatus>(resolve => { release = resolve; });
    vi.spyOn(engine, 'getStatus').mockImplementation(async () => { started(); return released; });
    const reading = sendControl({ command: 'status', jobId: 'draft' }, home);
    await statusStarted;
    try {
      // When
      const cancelled = await sendControl({ command: 'cancel', jobId: 'draft' }, home);
      const closing = control.close();
      await access(join(home, 'engine.json'));
      await expect(startControlServer(new JobEngine(), home)).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await engine.close(); release(await getStatus('draft'));
      const status = await reading;
      await closing;
      // Then
      expect(cancelled).toMatchObject({ state: 'CANCELLED' });
      expect(status).toMatchObject({ state: 'CANCELLED' });
      expect(control.close()).toBe(closing);
      await expect(access(join(home, 'engine.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { release(await getStatus('draft')); await engine.close(); await control.close(); }
  });
  it('joins an incomplete owned HTTP socket before removing metadata', async () => {
    // Given
    const { home, engine, control } = await fixture();
    const socket = connect(control.port, '127.0.0.1');
    const errors: Error[] = [];
    socket.on('error', error => errors.push(error));
    const connected = once(socket, 'connect');
    const exited = new Promise<void>(resolveExit => socket.once('close', () => resolveExit()));
    await connected;
    socket.write('GET /status HTTP/1.1\r\n');
    try {
      // When
      await engine.close(); await control.close(); await exited;
      // Then
      expect(socket.destroyed).toBe(true);
      for (const error of errors) expect(error).toMatchObject({ code: 'ECONNRESET' });
      await expect(access(join(home, 'engine.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { socket.destroy(); await engine.close(); await control.close(); }
  });
  it('retains status across authenticated requests when another client cancels', async () => {
    // Given
    const { home, engine, control } = await fixture();
    try {
      // When
      await sendControl({ command: 'cancel', jobId: 'draft' }, home);
      const result = await sendControl({ command: 'status', jobId: 'draft' }, home);
      // Then
      expect(result).toMatchObject({ jobId: 'draft', state: 'CANCELLED', executions: 0 });
    } finally { await engine.close(); await control.close(); }
  });
  it('rejects requests when the token is missing', async () => {
    // Given
    const { engine, control } = await fixture();
    try {
      // When
      const code = await new Promise<number | undefined>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: control.port, path: '/status' }, res => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject); req.end();
      });
      // Then
      expect(code).toBe(401);
    } finally { await engine.close(); await control.close(); }
  });
  it('preserves the original lock when a second engine attempts ownership', async () => {
    // Given
    const { home, engine, control } = await fixture(); const before = await readFile(join(home, 'engine.json'), 'utf8');
    try {
      // When / Then
      await expect(startControlServer(new JobEngine(), home)).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(await readFile(join(home, 'engine.json'), 'utf8')).toBe(before);
    } finally { await engine.close(); await control.close(); }
  });
  it.skipIf(process.platform === 'win32')('creates owner-only metadata when starting', async () => {
    // Given
    const { home, engine, control } = await fixture();
    try {
      // When
      const modes = await Promise.all([stat(home), stat(join(home, 'engine.json'))]);
      // Then
      expect(modes.map(info => info.mode & 0o777)).toEqual([0o700, 0o600]);
    } finally { await engine.close(); await control.close(); }
  });
  it.skipIf(process.platform === 'win32')('refuses insecure metadata when a client connects', async () => {
    // Given
    const { home, engine, control } = await fixture(); await chmod(join(home, 'engine.json'), 0o644);
    try {
      // When / Then
      await expect(sendControl({ command: 'status' }, home)).rejects.toMatchObject({ code: 'GUARD_REJECTED' });
    } finally { await engine.close(); await control.close(); }
  });
});
