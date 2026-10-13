import { describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bounded, heldConnectFixture, heldStatusFixture, serviceChild } from '../fixtures/control-service.js';

const cli = resolve('dist/cli/index.js');
const exec = promisify(execFile);

function ready(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolveReady, reject) => {
    let buffer = ''; let diagnostics = '';
    const timer = setTimeout(() => finish(new Error(`Foreground startup timeout: ${diagnostics}`)), 15000);
    const exit = () => finish(new Error(`Foreground exited: ${diagnostics}`));
    const stderr = (chunk: Buffer) => { diagnostics += chunk.toString(); };
    const data = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        const decoded: unknown = JSON.parse(line);
        const status = z.object({ state: z.string(), jobId: z.string() }).parse(decoded);
        if (status.state === 'ARMED' || status.state === 'WAITING') { finish(undefined, status.jobId); return; }
      }
    };
    const finish = (error?: Error, id?: string) => {
      clearTimeout(timer); child.off('exit', exit); child.off('error', finish);
      child.stdout.off('data', data); child.stderr.off('data', stderr);
      if (error) reject(error); else if (id) resolveReady(id);
    };
    child.stdout.on('data', data); child.stderr.on('data', stderr); child.once('exit', exit); child.once('error', finish);
  });
}

describe('compiled CLI surfaces', () => {
  it('verifies an independent acknowledgement with CLI flags and stays foreground after completion', async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), 'flashact-cli-verification-'));
    let clicks = 0;
    const fixture = createServer((req, res) => {
      if (req.url === '/receipt') { clicks++; res.end('accepted'); return; }
      res.setHeader('Content-Type', 'text/html');
      res.end(`<button id="reserve" onclick="fetch('/receipt',{method:'POST'}).then(() => {
        const receipt = document.createElement('span'); receipt.id = 'receipt'; document.body.append(receipt);
      })">reserve</button>`);
    });
    await new Promise<void>(resolveListen => fixture.listen(0, '127.0.0.1', resolveListen));
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('Fixture has no listener');
    const url = `http://127.0.0.1:${address.port}/`;
    const service = serviceChild(['--watch', '--launch', '--headless', '--url', url, '--approved-url', url,
      '--selector', '#reserve', '--when', 'enabled', '--action', 'click', '--scheduling', 'host',
      '--verify-selector', '#receipt', '--verify-timeout-ms', '3000'], home);
    try {
      // When
      const status = await service.waitForState('VERIFIED');
      // Then
      expect(status).toMatchObject({ state: 'VERIFIED', executions: 1, execution: {
        requested: 'host', scheduler: 'host-assisted', transport: 'owned-worker', reason: 'explicit-host',
      } });
      expect(clicks).toBe(1);
      expect(service.child.exitCode).toBeNull(); expect(service.child.signalCode).toBeNull();
      await access(join(home, 'engine.json'));
      service.child.kill('SIGTERM');
      expect(await bounded(service.exited, 'completed foreground exit')).toEqual({ code: 0, signal: null });
      expect(service.messages.at(-1)).toEqual(status);
      await expect(access(join(home, 'engine.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await service.stop();
      await new Promise<void>((resolveClose, reject) => {
        fixture.close(error => error ? reject(error) : resolveClose()); fixture.closeAllConnections();
      });
      await rm(home, { recursive: true, force: true });
    }
  }, 30000);
  it('joins an owned held-status producer on SIGINT and emits final UNKNOWN after control cleanup', async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), 'flashact-cli-held-'));
    const fixture = await heldStatusFixture();
    const service = serviceChild(['watch', '--launch', '--headless', '--url', fixture.url,
      '--approved-url', fixture.url, '--selector', '#pending', '--when', 'enabled', '--action', 'click'], home);
    try {
      await bounded(fixture.started, 'browser status started');
      await access(join(home, 'engine.json'));
      // When
      service.child.kill('SIGINT');
      const exited = await bounded(service.exited, 'SIGINT joined owner');
      // Then
      expect(exited).toEqual({ code: 0, signal: null });
      const final = service.messages.at(-1);
      expect(final).toMatchObject({ state: 'UNKNOWN', executions: 0, execution: {
        requested: 'auto', transport: 'owned-worker', browserOwnership: 'owned', scheduler: 'browser', reason: 'no-scheduled-leaves',
      } });
      expect(service.output().stderr).toBe('');
      await expect(access(join(home, 'engine.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await service.stop(); await fixture.close(); await rm(home, { recursive: true, force: true }); }
  }, 30000);
  it('joins connection acquisition when interrupted before foreground starts', async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), 'flashact-cli-connect-held-'));
    const fixture = await heldConnectFixture();
    const service = serviceChild(['watch', '--endpoint', fixture.endpoint, '--url', 'https://example.test/',
      '--approved-url', 'https://example.test/', '--selector', '#pending', '--when', 'enabled', '--action', 'click'], home);
    try {
      await bounded(fixture.started, 'CDP acquisition started');
      // When
      service.child.kill('SIGTERM');
      const exited = await bounded(service.exited, 'preforeground joined owner');
      // Then
      expect(exited).toEqual({ code: 0, signal: null });
      expect(service.output()).toEqual({ stdout: '', stderr: '' });
      await expect(access(join(home, 'engine.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await service.stop(); await fixture.close(); await rm(home, { recursive: true, force: true }); }
  }, 30000);
  it('prints a semantic version when invoked with --version', async () => {
    // Given
    const args = [cli, '--version'];
    // When
    const result = await exec(process.execPath, args);
    // Then
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/); expect(result.stderr).toBe('');
  });
  it('exits successfully when help is requested', async () => {
    // Given
    const args = [cli, '--help'];
    // When
    const result = await exec(process.execPath, args);
    // Then
    expect(result.stdout.length).toBeGreaterThan(100); expect(result.stderr).toBe('');
  });
  it('rejects scheduling when URL approval is omitted', async () => {
    // Given
    const args = [cli, 'schedule', '--at', '23:59:59.999', '--selector', '#reserve', '--action', 'click'];
    // When / Then
    await expect(exec(process.execPath, args)).rejects.toMatchObject({ code: 1 });
  });
  it('serves all ten MCP tools on protocol-only stdout and closes on EOF', async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), 'flashact-mcp-'));
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--mcp'], env: { ...process.env, FLASHACT_HOME: home }, stderr: 'pipe' });
    const client = new Client({ name: 'e2e', version: '1' });
    try {
      await client.connect(transport);
      // When
      const tools = await client.listTools();
      const result = await client.callTool({ name: 'flashact_create_job', arguments: { plan: {} } });
      // Then
      expect(tools.tools).toHaveLength(10); expect(result.isError).toBe(true);
      await client.close();
      await expect(access(join(home, 'engine.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await client.close(); await rm(home, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform === 'win32')('supports another CLI cancelling a live foreground job and signal teardown', async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), 'flashact-foreground-'));
    const fixture = createServer((_req, res) => res.end('<button id="reserve" disabled>reserve</button>'));
    await new Promise<void>(resolveListen => fixture.listen(0, '127.0.0.1', resolveListen));
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('Fixture has no port');
    const url = `http://127.0.0.1:${address.port}/`;
    const env = { ...process.env, FLASHACT_HOME: home };
    const child = spawn(process.execPath, [cli, '--watch', '--launch', '--headless', '--url', url,
      '--approved-url', url, '--selector', '#reserve', '--when', 'enabled', '--action', 'click',
      '--scheduling', 'browser'], { env });
    try {
      const id = await ready(child);
      // When
      await exec(process.execPath, [cli, '--cancel', id], { env });
      const result = await exec(process.execPath, [cli, '--status', id], { env });
      const decoded: unknown = JSON.parse(result.stdout);
      const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
      // Then
      expect(decoded).toMatchObject({ jobId: id, state: 'CANCELLED', executions: 0,
        execution: { requested: 'browser', transport: 'owned-worker', scheduler: 'browser', reason: 'explicit-browser' } });
      expect(child.exitCode).toBe(0);
      await expect(access(join(home, 'engine.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; }
      await new Promise<void>((resolveClose, reject) => fixture.close(error => error ? reject(error) : resolveClose()));
      await rm(home, { recursive: true, force: true });
    }
  }, 25000);
});
