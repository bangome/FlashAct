import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserAdapter } from '../../src/adapters/browser-adapter.js';
import * as factory from '../../src/adapters/factory.js';
import { JobEngine } from '../../src/core/engine.js';
import { FlashActError } from '../../src/utils/errors.js';

afterEach(() => vi.restoreAllMocks());

it('routes different connection options when both backends share an engine', async () => {
  // Given
  const adapter: BrowserAdapter = {
    async connect() {}, async disconnect() {}, async listTabs() { return []; }, async selectTab() {},
    async inspectTarget() { throw new FlashActError('INTERNAL_ERROR', 'Unused target inspection'); },
    async installRuntime() { throw new FlashActError('INTERNAL_ERROR', 'Unused installation'); },
    async arm() {}, async cancel() {}, async getStatus() { throw new FlashActError('INTERNAL_ERROR', 'Unused status'); },
    async evaluate() { return null; },
  };
  const create = vi.spyOn(factory, 'createAdapter').mockImplementation(() => adapter);
  const playwright = { launch: true, headless: true, url: 'http://127.0.0.1/fixture' };
  const aside = { account: 'test-account', executable: 'task-local-aside' };
  const engine = new JobEngine({ adapterOptionsByBackend: { playwright, aside } });
  try {
    // When
    await Promise.all([engine.listTabs('playwright'), engine.listTabs('aside')]);
    // Then
    expect(create.mock.calls).toEqual([['playwright', playwright], ['aside', aside]]);
  } finally { await engine.close(); }
});
