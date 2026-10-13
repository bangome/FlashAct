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
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env: { ...process.env, FLASHACT_HOME: home }, stderr: 'pipe' });
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
    const child = spawn(process.execPath, [cli, 'watch', '--launch', '--headless', '--url', url,
      '--approved-url', url, '--selector', '#reserve', '--when', 'enabled', '--action', 'click'], { env });
    try {
      const id = await ready(child);
      // When
      await exec(process.execPath, [cli, 'cancel', id], { env });
      const result = await exec(process.execPath, [cli, 'status', id], { env });
      const decoded: unknown = JSON.parse(result.stdout);
      const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
      // Then
      expect(decoded).toMatchObject({ jobId: id, state: 'CANCELLED', executions: 0 });
      expect(child.exitCode).toBe(0);
      await expect(access(join(home, 'engine.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; }
      await new Promise<void>((resolveClose, reject) => fixture.close(error => error ? reject(error) : resolveClose()));
      await rm(home, { recursive: true, force: true });
    }
  }, 25000);
});
