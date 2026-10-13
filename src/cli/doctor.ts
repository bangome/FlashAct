import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { z } from 'zod';
import type { JobEngine } from '../core/engine.js';

export async function doctor(engine: JobEngine): Promise<unknown> {
  const require = createRequire(import.meta.url);
  const version = z.object({ version: z.string() });
  let playwright = 'unavailable';
  try { playwright = version.parse(require('playwright/package.json')).version; }
  catch (error) { if (!(error instanceof Error)) throw error; }
  let aside = 'unavailable';
  try {
    const result = await promisify(execFile)('aside', ['--version'], { timeout: 5000, maxBuffer: 4096 });
    aside = /\d+\.\d+\.\d+(?:\.\d+)?/.exec(result.stdout)?.[0] ?? 'available';
  } catch (error) { if (!(error instanceof Error)) throw error; }
  let browserRunning = false;
  try { browserRunning = (await engine.listTabs('aside')).length > 0; }
  catch (error) { if (!(error instanceof Error)) throw error; }
  return { node: process.version, os: process.platform, supportedOS: ['darwin', 'win32', 'linux'].includes(process.platform),
    playwright, aside, browserRunning, foreground: true,
    warnings: ['Keep the foreground process alive.', 'Browser timers may be throttled; avoid sleep and keep the target tab active.',
      'Synchronize the system clock (NTP). Execution is not hard real-time.'] };
}
