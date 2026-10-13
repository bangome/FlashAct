import type { BrowserAdapter } from '../adapters/browser-adapter.js';
import { z } from 'zod';
import { runtimeSource } from '../runtime/index.js';
import { batchExpression } from './page-batch.js';
import { sampleSchema, summarize } from './statistics.js';

export const batchSchema = z.object({samples: z.array(sampleSchema), visibility: z.string(), measuredAt: z.number(),
  teardown: z.object({cancelledJobs: z.number()})});

export async function runBrowserBatches(adapter: BrowserAdapter, options: {readonly backend: 'playwright' | 'aside'; readonly iterations: number}) {
  await adapter.evaluate(runtimeSource());
  const results = [];
  for (const scenario of ['scheduled', 'reactive', 'and-time-first', 'and-element-first', 'or', 'simultaneous', 'replacement', 'high-cpu']) {
    const iterations = scenario === 'scheduled' || scenario === 'reactive' ? options.iterations : Math.min(20, options.iterations);
    const result = await adapter.evaluate(batchExpression({...options, iterations, scenario}));
    const decoded: unknown = JSON.parse(z.string().parse(result));
    const batch = batchSchema.parse(decoded);
    results.push({scenario, summary: summarize(batch.samples), ...batch});
  }
  return results;
}
