import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JobEngine } from '../../src/core/engine.js';
import { adapterOptions, commandPlan, connectionSchema } from '../../src/cli/plan.js';
import { runEngineLifetime } from '../../src/cli/foreground.js';
import { createMcpServer } from '../../src/mcp/server.js';
import * as factory from '../../src/adapters/factory.js';
import { FlashActError } from '../../src/utils/errors.js';

afterEach(() => vi.restoreAllMocks());
const input = { backend: 'playwright', tab: 'approved-tab', url: 'https://example.test/',
  approvedUrl: 'https://example.test/', selector: '#reserve', action: 'click', when: 'enabled' };

describe('CLI service plan boundary', () => {
  it('maps selector and timeout into verification while preserving approval and random IDs', async () => {
    // Given
    const engine = new JobEngine();
    // When
    const plan = await commandPlan(engine, { ...input, verifySelector: '#receipt', verifyTimeoutMs: '8123', approveIrreversible: true });
    const second = await commandPlan(engine, input);
    // Then
    expect(plan.verification).toEqual({ selector: '#receipt', timeoutMs: 8123 });
    expect(plan.guards).toEqual({ approvedUrl: input.approvedUrl, allowIrreversible: true });
    expect(plan.target).toEqual({ tabId: input.tab, url: input.url, selector: input.selector });
    expect(plan.jobId).not.toBe(second.jobId);
    expect(second.verification).toEqual({ timeoutMs: 5000 });
    await engine.close();
  });

  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992'])('rejects timeout %s before tab acquisition', async value => {
    // Given
    const engine = new JobEngine();
    const listing = vi.spyOn(engine, 'listTabs');
    // When / Then
    await expect(commandPlan(engine, { ...input, tab: undefined, verifyTimeoutMs: value })).rejects.toThrow();
    expect(listing).not.toHaveBeenCalled();
    await engine.close();
  });

  it.each([{ launch: true, endpoint: 'http://127.0.0.1:1' }, { backend: 'aside', launch: true },
    { backend: 'aside', headless: true }])('rejects incompatible connection options before acquisition: %j', options => {
    // Given / When / Then
    expect(() => connectionSchema.parse(options)).toThrow();
    expect(() => adapterOptions(options)).toThrow();
  });

  it('filters an endpoint URL without passing navigation authority to the adapter', async () => {
    // Given
    const engine = new JobEngine();
    const listing = vi.spyOn(engine, 'listTabs').mockResolvedValue([
      { id: 'other', title: '', url: 'https://other.test/' },
      { id: 'approved-tab', title: '', url: input.url },
    ]);
    // When
    const plan = await commandPlan(engine, { ...input, tab: undefined, endpoint: 'http://127.0.0.1:1' });
    // Then
    expect(plan.target.tabId).toBe('approved-tab');
    expect(listing).toHaveBeenCalledOnce();
    expect(adapterOptions({ endpoint: 'http://127.0.0.1:1', url: input.url })).toEqual({ endpoint: 'http://127.0.0.1:1' });
    await engine.close();
  });
});

describe('service capabilities and lifetime', () => {
  it('propagates a genuine failed cleanup instead of treating its signal as success', async () => {
    // Given
    const engine = new JobEngine();
    const failure = new FlashActError('ADAPTER_ERROR', 'private endpoint or page data');
    vi.spyOn(engine, 'close').mockRejectedValue(failure);
    // When / Then
    await expect(runEngineLifetime(engine, async () => { process.emit('SIGINT'); })).rejects.toBe(failure);
  });
  it.each([undefined, new JobEngine({ scheduling: 'browser' })])('lists capabilities without acquiring adapters and preserves an injected engine', async engine => {
    // Given
    const owned = vi.spyOn(factory, 'createOwnedAdapter');
    const direct = vi.spyOn(factory, 'createAdapter');
    const server = engine ? createMcpServer(engine) : createMcpServer();
    const client = new Client({ name: 'capabilities', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      // When
      const tools = await client.listTools();
      const result = await client.callTool({ name: 'flashact_list_backends', arguments: {} });
      // Then
      expect(tools.tools).toHaveLength(10);
      const content = result.content;
      expect(Array.isArray(content)).toBe(true);
      const item = Array.isArray(content) ? content[0] : undefined;
      if (!item || typeof item.text !== 'string') throw new Error('Missing structured capability response');
      const { captcha, ...existing } = JSON.parse(item.text);
      expect(existing).toEqual({
        backends: ['playwright', 'aside'], singleShot: true, foreground: true, asideRequiresExistingTab: true,
        capabilities: engine?.capabilities() ?? [
          { backend: 'playwright', connectionConfigured: false, transport: 'owned-worker', hostWake: true, shutdown: 'owned' },
          { backend: 'aside', connectionConfigured: true, transport: 'owned-aside-cli', hostWake: false, shutdown: 'owned' },
        ], defaultScheduling: engine?.defaultScheduling ?? 'auto',
      });
      expect(captcha).toMatchObject({
        provider: 'macos-vision', requiresSwift: true, textImageOnly: true,
        prepareBeforeArm: true, maxInputs: 1, maxSubmissions: 1,
        planSchema: {
          required: ['imageSelector', 'inputSelector'],
          dependentRequired: { submitSelector: ['successSelector'] },
          properties: {
            length: { default: 6, minimum: 1, maximum: 32 },
            timeoutMs: { default: 15000, minimum: 100, maximum: 120000 },
          },
        },
      });
      expect(owned).not.toHaveBeenCalled(); expect(direct).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); await engine?.close(); }
  });

  it('initiates one engine close synchronously on repeated signals before the action completes', async () => {
    // Given
    const engine = new JobEngine();
    const close = vi.spyOn(engine, 'close');
    let complete: () => void = () => undefined;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    let started: () => void = () => undefined;
    const actionStarted = new Promise<void>(resolve => { started = resolve; });
    let aborted = false;
    const running = runEngineLifetime(engine, async signal => {
      signal.addEventListener('abort', () => { aborted = true; });
      started(); await completed;
    });
    await actionStarted;
    // When
    process.emit('SIGINT'); process.emit('SIGTERM');
    // Then
    expect(close).toHaveBeenCalledOnce(); expect(aborted).toBe(true);
    complete(); await running;
    expect(close).toHaveBeenCalledOnce();
  });
});
