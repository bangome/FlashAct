import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createCli } from '../../src/cli/index.js';
import { commandPlan } from '../../src/cli/plan.js';
import { foreground } from '../../src/cli/foreground.js';
import { JobEngine } from '../../src/core/engine.js';
import { jobStatusSchema } from '../../src/core/schema.js';
import type { JobStatus } from '../../src/core/types.js';

vi.mock('../../src/cli/ipc.js', () => ({
  startControlServer: async () => ({ stopAdmission: () => undefined, close: async () => undefined }),
}));

const input = { backend: 'playwright', tab: 'approved-tab', url: 'https://example.test/',
  approvedUrl: 'https://example.test/', selector: '#reserve', action: 'click', when: 'enabled' };
const captcha = { captchaImage: '#image', captchaInput: '#answer' };
let engine: JobEngine;
beforeEach(() => { engine = new JobEngine(); });
afterEach(async () => { vi.restoreAllMocks(); await engine.close(); });

describe('CAPTCHA CLI plan boundary', () => {
  it('keeps omitted CAPTCHA configuration absent', async () => {
    // Given / When
    const plan = await commandPlan(engine, input);
    // Then
    expect(plan.captcha).toBeUndefined();
    expect(plan.verification.timeoutMs).toBe(5000);
  });

  it.each(['--watch', '--schedule', '--arm'])('parses all CAPTCHA flags through %s', async name => {
    // Given
    const program = createCli();
    const command = program.commands.find(item => item.name() === name);
    if (!command) throw new Error('Missing action command');
    let parsed: unknown;
    command.action((options: unknown) => { parsed = options; });
    const timing = name === '--watch' ? ['--when', 'enabled'] :
      name === '--schedule' ? ['--at', '2100-01-01T00:00:00Z'] :
        ['--at', '2100-01-01T00:00:00Z', '--when', 'enabled'];
    // When
    await program.parseAsync([name, '--tab', input.tab, '--approved-url', input.approvedUrl,
      '--action', 'click', '--selector', '#reserve', ...timing,
      '--verify-selector', '#receipt', '--captcha-image', '#image', '--captcha-input', '#answer',
      '--captcha-submit', '#submit', '--captcha-success', '#success', '--captcha-length', '4',
      '--captcha-alphabet', 'digits', '--captcha-min-confidence', '0.93', '--captcha-timeout-ms', '22000'],
    { from: 'user' });
    const plan = await commandPlan(engine, parsed);
    // Then
    expect(plan.captcha).toEqual({ imageSelector: '#image', inputSelector: '#answer',
      submitSelector: '#submit', successSelector: '#success', length: 4, alphabet: 'digits',
      minConfidence: 0.93, timeoutMs: 22000 });
    expect(plan.verification).toEqual({ selector: '#receipt', timeoutMs: 24000 });
  });

  it('applies schema defaults and extends primary verification', async () => {
    // Given / When
    const plan = await commandPlan(engine, { ...input, ...captcha, verifySelector: '#receipt' });
    // Then
    expect(plan.captcha).toEqual({ imageSelector: '#image', inputSelector: '#answer',
      alphabet: 'uppercase-alphanumeric', length: 6, minConfidence: 0.8, timeoutMs: 15000 });
    expect(plan.verification.timeoutMs).toBe(17000);
  });

  it.each([
    { captchaImage: '#image' }, { captchaInput: '#answer' }, { captchaSubmit: '#submit' },
    { captchaSuccess: '#success' }, { captchaLength: '6' }, { captchaAlphabet: 'digits' },
    { captchaMinConfidence: '0.9' }, { captchaTimeoutMs: '15000' },
    { ...captcha, captchaSubmit: '#submit' }, { ...captcha, captchaImage: ' ' },
    { ...captcha, captchaLength: '0' }, { ...captcha, captchaLength: '33' },
    { ...captcha, captchaLength: '1.5' }, { ...captcha, captchaAlphabet: 'unknown' },
    { ...captcha, captchaMinConfidence: '-0.1' }, { ...captcha, captchaMinConfidence: '1.1' },
    { ...captcha, captchaTimeoutMs: '99' }, { ...captcha, captchaTimeoutMs: '120001' },
    { ...captcha, captchaTimeoutMs: 'NaN' },
    { ...captcha, verifySelector: '#receipt', verifyTimeoutMs: '14999' },
  ])('rejects partial or invalid configuration before tab acquisition: %j', async options => {
    // Given
    const listing = vi.spyOn(engine, 'listTabs');
    // When / Then
    await expect(commandPlan(engine, { ...input, tab: undefined, ...options })).rejects.toThrow();
    expect(listing).not.toHaveBeenCalled();
  });

  it.each([
    { verifySelector: '#receipt', verifyTimeoutMs: '15000', expected: 15000 },
    { verifySelector: '#receipt', verifyTimeoutMs: '24000', expected: 24000 },
    { verifyTimeoutMs: '1000', expected: 1000 },
    { expected: 5000 },
  ])('preserves explicit or selector-free verification: %j', async ({ expected, ...options }) => {
    // Given / When
    const plan = await commandPlan(engine, { ...input, ...captcha, ...options });
    // Then
    expect(plan.verification.timeoutMs).toBe(expected);
  });

  it('rejects a CAPTCHA flag missing its argument in the actual parser', async () => {
    // Given
    const program = createCli().exitOverride().configureOutput({ writeErr: () => undefined });
    for (const command of program.commands)
      command.exitOverride().configureOutput({ writeErr: () => undefined });
    // When / Then
    await expect(program.parseAsync(['--watch', '--approved-url', input.approvedUrl,
      '--action', 'click', '--when', 'enabled', '--captcha-image'], { from: 'user' }))
      .rejects.toMatchObject({ code: 'commander.optionMissingArgument' });
  });
});

describe('CAPTCHA foreground evidence', () => {
  it('publishes nested changes while deduplicating identical evidence independently of main VERIFIED', async () => {
    // Given
    const plan = await commandPlan(engine, { ...input, ...captcha });
    const controller = new AbortController();
    const statuses: readonly JobStatus[] = [
      { jobId: plan.jobId, state: 'VERIFIED', executions: 1, updatedAt: 100,
        captcha: { state: 'FILLED', inputs: 1, submissions: 0, confidence: 0.95 } },
      { jobId: plan.jobId, state: 'VERIFIED', executions: 1, updatedAt: 100,
        captcha: { state: 'SUBMITTED', inputs: 1, submissions: 1, confidence: 0.95 } },
      { jobId: plan.jobId, state: 'VERIFIED', executions: 1, updatedAt: 100,
        captcha: { state: 'FAILED', inputs: 1, submissions: 1, error: 'TIMEOUT',
          timing: { captureMs: 2, recognitionMs: 3, inputMs: 1, totalMs: 20 } } },
    ];
    const first = statuses[0];
    const last = statuses[2];
    if (!first || !last) throw new Error('Missing status fixture');
    let publish: (status: JobStatus) => void = () => undefined;
    vi.spyOn(engine, 'subscribe').mockImplementation(listener => { publish = listener; return () => undefined; });
    vi.spyOn(engine, 'createJob').mockResolvedValue(first);
    vi.spyOn(engine, 'validateJob').mockResolvedValue(first);
    vi.spyOn(engine, 'armJob').mockImplementation(async () => {
      for (const status of statuses) { publish(status); publish(status); }
      controller.abort();
      return last;
    });
    vi.spyOn(engine, 'getStatus').mockResolvedValue(last);
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
    // When
    await foreground(engine, plan, controller.signal);
    // Then
    expect(z.array(jobStatusSchema).parse(output.map(line => JSON.parse(line)))).toEqual(statuses);
  });
});
