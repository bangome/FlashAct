import { z } from 'zod';

const optionsSchema = z.strictObject({
  backend: z.enum(['playwright', 'aside']).default('playwright'),
  iterations: z.number().int().min(1).max(10000).default(10),
  mode: z.enum(['browser', 'node', 'cdp']).default('browser'), headless: z.boolean().default(true),
  tabId: z.string().optional(), endpoint: z.string().optional(), output: z.string().optional(),
});
export async function benchmark(input: unknown): Promise<unknown> {
  const options = optionsSchema.parse(input);
  const { runBenchmark } = await import('../benchmark/index.js');
  return runBenchmark({ backend: options.backend, iterations: options.iterations, mode: options.mode, headless: options.headless,
    ...(options.tabId === undefined ? {} : { tabId: options.tabId }),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.output === undefined ? {} : { output: options.output }),
  });
}
