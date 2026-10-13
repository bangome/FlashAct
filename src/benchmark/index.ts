import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { platform, release, arch } from 'node:os';
import { chromium } from 'playwright';
import { z } from 'zod';
import { createAdapter } from '../adapters/factory.js';
import { FlashActError } from '../utils/errors.js';
import { serveFixture } from './fixture.js';
import { runBrowserBatches, batchSchema } from './browser.js';
import { runBaseline } from './baseline.js';
import { batchExpression } from './page-batch.js';
import { summarize } from './statistics.js';
import { runLifecycle } from './lifecycle.js';
import { runAside } from './aside.js';

export type BenchmarkOptions = {
  readonly backend?: 'playwright' | 'aside'; readonly iterations?: number;
  readonly mode?: 'browser' | 'node' | 'cdp'; readonly output?: string;
  readonly tabId?: string; readonly endpoint?: string; readonly headless?: boolean;
};
const optionsSchema = z.strictObject({
  backend: z.enum(['playwright', 'aside']).default('playwright'), iterations: z.number().int().min(1).max(10000).default(1000),
  mode: z.enum(['browser', 'node', 'cdp']).default('browser'), output: z.string().optional(),
  tabId: z.string().optional(), endpoint: z.string().optional(), headless: z.boolean().default(true),
});

export async function runBenchmark(input: unknown = {}) {
  const options = optionsSchema.parse(input);
  if (options.endpoint) throw new FlashActError('GUARD_REJECTED', 'Benchmarks only launch owned browsers; external endpoints are not used');
  if (options.backend === 'aside' && options.mode !== 'browser') {
    throw new FlashActError('GUARD_REJECTED', 'Node/CDP comparison requires an owned Playwright browser, not Aside private APIs');
  }
  const fixture = await serveFixture();
  const results = [];
  const receipts: string[] = [];
  let version = '';
  try {
    await mkdir('artifacts/benchmark', {recursive: true});
    if (options.backend === 'aside') {
      const aside = await runAside(fixture.url, {iterations: options.iterations, ...(options.tabId ? {tabId: options.tabId} : {})});
      results.push(...aside.results);
      if (aside.lifecycle) results.push({scenario: 'lifecycle', summary: summarize([]), samples: [], evidence: aside.lifecycle});
      receipts.push(...aside.receipts);
      version = 'Aside official CLI / real existing browser';
    } else {
      const browser = await chromium.launch({headless: options.headless});
      try {
        version = browser.version();
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(fixture.url);
        const adapter = createAdapter('playwright', {page});
        await adapter.connect();
        try {
          if (options.mode === 'browser') {
            results.push(...await runBrowserBatches(adapter, options));
            const background = await context.newPage();
            await background.goto(fixture.url);
            await background.bringToFront();
            const decoded: unknown = JSON.parse(z.string().parse(await adapter.evaluate(batchExpression({...options, iterations: Math.min(20, options.iterations), scenario: 'background'}))));
            const batch = batchSchema.parse(decoded);
            results.push({scenario: 'background', summary: summarize(batch.samples), ...batch});
            await background.close();
          } else {
            const baseline = await runBaseline(page, {...options, mode: options.mode});
            results.push({scenario: `${options.mode}-scheduled`, summary: summarize(baseline.samples), ...baseline});
          }
          await page.screenshot({path: `artifacts/benchmark/${options.backend}-${options.mode}.png`});
          const evidence = await runLifecycle(adapter, page);
          results.push({scenario: 'lifecycle', summary: summarize([]), samples: [], evidence});
          receipts.push('Adapter disconnected/reconnected; pending job invalidated on task-owned page closure');
        } finally { await adapter.disconnect(); }
      } finally { await browser.close(); receipts.push('Task-owned Chromium browser closed'); }
    }
  } finally { await fixture.close(); receipts.push('Ephemeral loopback fixture server closed'); }
  const report = {schemaVersion: '1.0', backend: options.backend, mode: options.mode, iterations: options.iterations,
    environment: {platform: platform(), release: release(), arch: arch(), node: process.version, browser: version, headless: options.headless},
    measuredAt: new Date().toISOString(), results, teardown: receipts,
    limitations: ['Synthetic HTMLElement.click events are untrusted; no server-success or physical-input guarantee',
      'Windows and full-system CPU saturation NOT VERIFIED', 'Background visibility is recorded; headless may remain visible',
      'High-CPU scenario is a 30ms page-main-thread busy loop, not full-system saturation'],
  };
  if (options.output) {
    await mkdir(dirname(options.output), {recursive: true});
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

export type BenchmarkReport = Awaited<ReturnType<typeof runBenchmark>>;
