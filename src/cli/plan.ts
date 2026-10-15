import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AdapterOptions } from '../adapters/browser-adapter.js';
import type { JobEngine } from '../core/engine.js';
import { parsePlan } from '../core/schema.js';
import { captchaPlanSchema } from '../captcha/schema.js';
import type { Trigger } from '../core/types.js';
import { FlashActError } from '../utils/errors.js';
import { parseTime } from './time.js';

export const connectionSchema = z.object({
  backend: z.enum(['playwright', 'aside']).default('playwright'),
  endpoint: z.string().optional(), launch: z.boolean().optional(), headless: z.boolean().optional(),
  tab: z.string().optional(), url: z.string().optional(),
  scheduling: z.enum(['auto', 'browser', 'host']).default('auto'),
}).superRefine(options => {
  if (options.launch && options.endpoint)
    throw new FlashActError('INVALID_PLAN', 'Choose --endpoint or --launch, not both');
  if (options.backend === 'aside' && (options.launch || options.headless))
    throw new FlashActError('INVALID_PLAN', 'Aside attaches existing tabs only');
});
export function adapterOptions(input: unknown): AdapterOptions {
  const options = connectionSchema.parse(input);
  return {
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.launch === undefined ? {} : { launch: options.launch }),
    ...(options.headless === undefined ? {} : { headless: options.headless }),
    ...(options.url === undefined || !options.launch ? {} : { url: options.url }),
    ...(options.tab === undefined ? {} : { tabId: options.tab }),
  };
}

export async function selectedTab(engine: JobEngine, input: unknown): Promise<string> {
  const options = connectionSchema.parse(input);
  if (options.tab) return options.tab;
  if (options.backend === 'aside') throw new FlashActError('INVALID_PLAN', 'Aside requires --tab for an existing selected tab');
  const tabs = await engine.listTabs(options.backend);
  const matching = options.url ? tabs.filter(tab => tab.url === options.url) : tabs;
  if (matching.length !== 1 || !matching[0]) throw new FlashActError('INVALID_PLAN', 'Select one existing tab with --tab');
  return matching[0].id;
}

const planOptionsSchema = connectionSchema.safeExtend({
  approvedUrl: z.string(), approveIrreversible: z.boolean().default(false), selector: z.string().optional(),
  action: z.literal('click'), at: z.string().optional(), when: z.string().optional(),
  attribute: z.string().optional(), value: z.string().optional(), timezone: z.string().default('UTC'),
  verifySelector: z.string().min(1).optional(),
  verifyTimeoutMs: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  captchaImage: z.string().optional(), captchaInput: z.string().optional(),
  captchaSubmit: z.string().optional(), captchaSuccess: z.string().optional(),
  captchaLength: z.coerce.number().optional(), captchaAlphabet: z.string().optional(),
  captchaMinConfidence: z.coerce.number().optional(), captchaTimeoutMs: z.coerce.number().optional(),
});

export async function commandPlan(engine: JobEngine, input: unknown) {
  const options = planOptionsSchema.parse(input);
  const captchaInput = {
    imageSelector: options.captchaImage, inputSelector: options.captchaInput,
    submitSelector: options.captchaSubmit, successSelector: options.captchaSuccess,
    length: options.captchaLength, alphabet: options.captchaAlphabet,
    minConfidence: options.captchaMinConfidence, timeoutMs: options.captchaTimeoutMs,
  };
  const captchaFields = Object.entries(captchaInput).filter(([, value]) => value !== undefined);
  const captcha = captchaFields.length ? captchaPlanSchema.parse(Object.fromEntries(captchaFields)) : undefined;
  const verifyTimeoutMs = options.verifyTimeoutMs ??
    (captcha && options.verifySelector ? Math.max(5000, captcha.timeoutMs + 2000) : 5000);
  if (captcha && options.verifySelector && verifyTimeoutMs < captcha.timeoutMs)
    throw new FlashActError('INVALID_PLAN', '--verify-timeout-ms must cover --captcha-timeout-ms');
  let selector = options.selector;
  let condition = options.when;
  const shorthand = condition ? /^(.*):(enabled|appear|visible)$/.exec(condition) : null;
  if (shorthand) { selector ??= shorthand[1]; condition = shorthand[2]; }
  if (!selector) throw new FlashActError('INVALID_PLAN', 'A target selector is required');
  const conditions: Trigger[] = [];
  if (options.at) conditions.push({ type: 'SCHEDULED', at: parseTime(options.at, options.timezone) });
  switch (condition) {
    case undefined: break;
    case 'enabled': conditions.push({ type: 'ELEMENT_ENABLE', selector }); break;
    case 'appear': conditions.push({ type: 'ELEMENT_APPEAR', selector }); break;
    case 'visible': conditions.push({ type: 'ELEMENT_VISIBLE', selector }); break;
    case 'attribute':
      if (!options.attribute) throw new FlashActError('INVALID_PLAN', '--attribute is required');
      conditions.push({ type: 'ATTRIBUTE_CHANGE', selector, attribute: options.attribute, ...(options.value === undefined ? {} : { value: options.value }) }); break;
    case 'text': conditions.push({ type: 'TEXT_CHANGE', selector, ...(options.value === undefined ? {} : { value: options.value }) }); break;
    default: throw new FlashActError('INVALID_PLAN', 'Unknown watch condition');
  }
  const first = conditions[0];
  if (!first) throw new FlashActError('INVALID_PLAN', 'Provide --at or --when');
  const trigger: Trigger = conditions.length === 1 ? first : { type: 'AND', conditions };
  const scheduled = conditions.find(item => item.type === 'SCHEDULED');
  const tabId = await selectedTab(engine, options);
  return parsePlan({ schemaVersion: '1.0', jobId: randomUUID(), name: 'foreground', backend: options.backend,
    target: { tabId, selector, url: options.url ?? options.approvedUrl }, trigger, action: { type: options.action },
    timezone: options.timezone, expiresAt: scheduled?.type === 'SCHEDULED' ? scheduled.at + 60_000 : Date.now() + 86_400_000,
    maxExecutions: 1, ...(captcha === undefined ? {} : { captcha }), verification: { timeoutMs: verifyTimeoutMs,
      ...(options.verifySelector === undefined ? {} : { selector: options.verifySelector }) },
    guards: { approvedUrl: options.approvedUrl, allowIrreversible: options.approveIrreversible },
  });
}
