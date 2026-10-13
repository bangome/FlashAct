import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { serveFixture } from '../../src/benchmark/fixture.js';

let fixtureBrowser: Promise<Browser> | undefined;

afterAll(async () => {
  if (fixtureBrowser) await (await fixtureBrowser).close();
});

async function withFixturePage(query: string, check: (page: Page) => Promise<void>) {
  const fixture = await serveFixture();
  try {
    fixtureBrowser ??= chromium.launch({headless: true});
    const context = await (await fixtureBrowser).newContext();
    try {
      const page = await context.newPage();
      await page.clock.install({time: 0});
      // Installation starts running; freeze forward before authored timers exist.
      await page.clock.pauseAt(1_600_000_000_000);
      await page.goto(`${fixture.url}${query}`);
      await check(page);
    } finally { await context.close(); }
  } finally { await fixture.close(); }
}

describe('packaged benchmark fixture', () => {
  it('serves and closes when a subprocess starts from an unrelated cwd', async () => {
    // Given
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'flashact-fixture-cwd-')));
    const moduleUrl = new URL('../../dist/benchmark/fixture.js', import.meta.url).href;
    const program = `import {serveFixture} from ${JSON.stringify(moduleUrl)}; import {get} from 'node:http';
      const fixture = await serveFixture(); let response;
      try { response = await new Promise((resolve,reject) => {get(fixture.url+'?ready=1',res => {
        res.resume(); res.once('end',()=>resolve({status:res.statusCode,contentType:res.headers['content-type']}));
      }).once('error',reject);}); }
      finally {await fixture.close(); console.log(JSON.stringify({response,closed:true,cwd:process.cwd()}));}`;
    try {
      // When
      const {stdout} = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', program], {cwd, timeout: 10000});
      const decoded: unknown = JSON.parse(stdout);
      const receipt = z.object({response: z.object({status: z.number(), contentType: z.string()}), closed: z.boolean(), cwd: z.string()}).parse(decoded);
      // Then
      expect(receipt).toEqual({response: {status: 200, contentType: 'text/html; charset=utf-8'}, closed: true, cwd});
    } finally { await rm(cwd, {recursive: true, force: true}); }
  });

  it.each([['', false], ['?ready=1', true]] as const)('sets authored enabled state when query is %s', async (query, enabled) => {
    // Given
    await withFixturePage(query, async page => {
      // When
      const actual = await page.locator('#reserve').isEnabled();
      // Then
      expect(actual).toBe(enabled);
    });
  });

  it.each([[4999, false], [5000, true]] as const)('sets enabled state when %i ms elapsed after enableAfter=5000', async (elapsed, enabled) => {
    // Given
    await withFixturePage('?enableAfter=5000', async page => {
      // When
      await page.clock.fastForward(elapsed);
      // Then
      expect(await page.locator('#reserve').isEnabled()).toBe(enabled);
    });
  });

  it.each(['-1', '1.5', '60001', 'x', ''])('keeps the button disabled when enableAfter is invalid: %s', async delay => {
    // Given
    await withFixturePage(`?enableAfter=${delay}`, async page => {
      // When
      await page.clock.fastForward(60001);
      // Then
      expect(await page.locator('#reserve').isDisabled()).toBe(true);
    });
  });

  it('cancels authored activation when a benchmark resets the fixture', async () => {
    // Given
    await withFixturePage('?enableAfter=5000', async page => {
      await page.evaluate('globalThis.__flashactFixture.reset("benchmark-owned",false)');
      // When
      await page.clock.fastForward(60001);
      // Then
      expect(await page.locator('#reserve').isDisabled()).toBe(true);
    });
  });
});
