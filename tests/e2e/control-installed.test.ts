import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);

describe.skipIf(process.platform === 'win32')('npm-installed symlink entrypoint', () => {
  let prefix = '';
  beforeAll(async () => {
    prefix = await mkdtemp(join(tmpdir(), 'flashact-installed-'));
    const packed = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', prefix], { cwd: resolve('.'), timeout: 30000 });
    const decoded: unknown = JSON.parse(packed.stdout);
    const archive = z.array(z.object({ filename: z.string() })).parse(decoded)[0];
    if (!archive) throw new Error('npm pack returned no archive');
    await exec('npm', ['install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(prefix, archive.filename)], { timeout: 60000 });
  }, 90000);
  afterAll(async () => { if (prefix) await rm(prefix, { recursive: true, force: true }); });

  it('prints help when invoked through the installed bin symlink and temporary-directory alias', async () => {
    // Given
    const bin = join(prefix, 'node_modules', '.bin', 'fa');
    const canonical = await realpath(bin);
    expect(canonical).not.toBe(bin);
    // When
    const result = await exec(bin, ['--help'], { cwd: prefix });
    // Then
    expect(result.stdout).toMatch(/^Usage: fa/m); expect(result.stderr).toBe('');
  });
  it('accepts a dashed command through the installed fa entrypoint', async () => {
    // Given
    const bin = join(prefix, 'node_modules', '.bin', 'fa');
    // When
    const result = await exec(bin, ['--tabs', '--help'], { cwd: prefix });
    // Then
    expect(result.stdout).toMatch(/^Usage: fa --tabs/m); expect(result.stderr).toBe('');
  });
  it('keeps the original flashact executable available', async () => {
    // Given
    const bin = join(prefix, 'node_modules', '.bin', 'flashact');
    // When
    const result = await exec(bin, ['--version'], { cwd: prefix });
    // Then
    expect(result.stdout.trim()).toBe('0.1.0'); expect(result.stderr).toBe('');
  });
  it('serves MCP through installed fa --mcp from an unrelated working directory', async () => {
    // Given
    const home = join(prefix, 'mcp-home');
    const transport = new StdioClientTransport({ command: join(prefix, 'node_modules', '.bin', 'fa'),
      args: ['--mcp'], cwd: prefix, env: { ...process.env, FLASHACT_HOME: home }, stderr: 'pipe' });
    const client = new Client({ name: 'installed-fa', version: '1' });
    try {
      await client.connect(transport);
      // When
      const tools = await client.listTools();
      // Then
      expect(tools.tools).toHaveLength(10);
      await client.close();
      await expect(access(join(home, 'engine.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await client.close(); }
  });
  it('prints the version when invoked via the installed direct path', async () => {
    // Given
    const entry = join(prefix, 'node_modules', 'flashact', 'dist', 'cli', 'index.js');
    // When
    const result = await exec(process.execPath, [entry, '--version'], { cwd: prefix });
    // Then
    expect(result.stdout.trim()).toBe('0.1.0'); expect(result.stderr).toBe('');
  });
});
