import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

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
    const bin = join(prefix, 'node_modules', '.bin', 'flashact');
    const canonical = await realpath(bin);
    expect(canonical).not.toBe(bin);
    // When
    const result = await exec(bin, ['--help'], { cwd: prefix });
    // Then
    expect(result.stdout).toMatch(/^Usage: flashact/m); expect(result.stderr).toBe('');
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
