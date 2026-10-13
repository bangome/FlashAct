import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { BrowserAdapter } from '../../src/adapters/browser-adapter.js';
import { JobEngine } from '../../src/core/engine.js';
import type { ExecutionPlan, JobStatus, TargetInfo } from '../../src/core/types.js';
import { FlashActError } from '../../src/utils/errors.js';
import { createMcpServer } from '../../src/mcp/server.js';

const plan: ExecutionPlan = {
  schemaVersion: '1.0', jobId: 'job', name: 'test', backend: 'playwright',
  target: { tabId: 'tab', selector: '#button', url: 'https://example.test/' },
  trigger: { type: 'ELEMENT_ENABLE', selector: '#button' }, action: { type: 'click' }, timezone: 'UTC',
  expiresAt: 10000, maxExecutions: 1, verification: { timeoutMs: 100 },
  guards: { approvedUrl: 'https://example.test/', allowIrreversible: false },
};

class MemoryAdapter implements BrowserAdapter {
  target: TargetInfo = { selector: '#button', count: 1, enabled: true, visible: true, irreversible: false, url: plan.target.url };
  readonly statuses = new Map<string, JobStatus>();
  readonly cleanup: string[] = [];
  async connect() {}
  async listTabs() { return [{ id: 'tab', url: this.target.url, title: '' }]; }
  async selectTab(id: string) { if (id !== 'tab') throw new FlashActError('ADAPTER_ERROR', 'No tab'); }
  async inspectTarget() { return this.target; }
  async installRuntime(input: ExecutionPlan) {
    this.statuses.set(input.jobId, { jobId: input.jobId, state: 'VALIDATED', executions: 0, updatedAt: 1 });
    return { jobId: input.jobId, documentId: 'doc' };
  }
  async arm(input: ExecutionPlan) { this.statuses.set(input.jobId, { jobId: input.jobId, state: 'WAITING', executions: 0, updatedAt: 1 }); }
  async cancel(id: string) { this.cleanup.push(`cancel:${id}`); this.statuses.set(id, { jobId: id, state: 'CANCELLED', executions: 0, updatedAt: 2 }); }
  async getStatus(id: string) {
    const status = this.statuses.get(id);
    if (!status) throw new FlashActError('JOB_NOT_FOUND', 'No runtime');
    return status;
  }
  async evaluate() { return null; }
  async disconnect() { this.cleanup.push('disconnect'); }
}

function fixture() {
  const adapter = new MemoryAdapter();
  return { adapter, engine: new JobEngine({ adapters: { playwright: adapter, aside: adapter }, now: () => 100 }) };
}

describe('foreground engine', () => {
  it('keeps a runtime waiting when status is polled', async () => {
    // Given
    const { engine, adapter } = fixture();
    await engine.createJob(plan); await engine.validateJob('job'); await engine.armJob('job');
    try {
      // When
      const statuses = await Promise.all([engine.getStatus('job'), engine.getStatus('job')]);
      // Then
      expect(statuses.map(status => [status.state, status.executions])).toEqual([['WAITING', 0], ['WAITING', 0]]);
      expect(adapter.statuses.size).toBe(1);
    } finally { await engine.close(); }
  });
  it.each([
    { count: 2 }, { count: 0 }, { url: 'https://elsewhere.test/' }, { irreversible: true },
  ])('rejects unsafe targets before runtime installation when %j', async target => {
    // Given
    const { engine, adapter } = fixture(); adapter.target = { ...adapter.target, ...target };
    await engine.createJob(plan);
    try {
      // When / Then
      await expect(engine.validateJob('job')).rejects.toMatchObject({ code: 'GUARD_REJECTED' });
      expect(adapter.statuses.size).toBe(0);
    } finally { await engine.close(); }
  });
  it('rechecks URL when navigation occurs after validation', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job');
    adapter.target = { ...adapter.target, url: 'https://elsewhere.test/' };
    try {
      // When / Then
      await expect(engine.armJob('job')).rejects.toMatchObject({ code: 'GUARD_REJECTED' });
      expect(adapter.statuses.size).toBe(0);
    } finally { await engine.close(); }
  });
  it('allows a missing target when an APPEAR condition gates it', async () => {
    // Given
    const { engine, adapter } = fixture(); adapter.target = { ...adapter.target, count: 0 };
    await engine.createJob({ ...plan, trigger: { type: 'ELEMENT_APPEAR', selector: '#button' } });
    try {
      // When
      const status = await engine.validateJob('job');
      // Then
      expect(status.state).toBe('VALIDATED');
    } finally { await engine.close(); }
  });
  it('cancels installed jobs before disconnect when closing', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job'); await engine.armJob('job');
    // When
    await engine.close();
    // Then
    expect(adapter.cleanup).toEqual(['cancel:job', 'disconnect']);
  });
  it('redacts browser messages when returning status and logs', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job'); await engine.armJob('job');
    adapter.statuses.set('job', { jobId: 'job', state: 'VERIFIED', executions: 1, updatedAt: 101, message: 'cookie=secret https://example.test/?token=secret' });
    try {
      // When
      const output = JSON.stringify([await engine.getStatus('job'), engine.logs()]);
      // Then
      expect(output).not.toContain('secret');
    } finally { await engine.close(); }
  });
  it('retains a verified dispatch when the arm acknowledgement and cancellation transport fail', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job');
    vi.spyOn(adapter, 'arm').mockImplementation(async () => {
      adapter.statuses.set('job', { jobId: 'job', state: 'VERIFIED', executions: 1, updatedAt: 101 });
      throw new FlashActError('ADAPTER_ERROR', 'Arm acknowledgement lost');
    });
    vi.spyOn(adapter, 'cancel').mockRejectedValue(new FlashActError('ADAPTER_ERROR', 'Cancellation transport lost'));
    try {
      // When
      await expect(engine.armJob('job')).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
      const result = await engine.getResult('job');
      // Then
      expect(result).toMatchObject({ state: 'VERIFIED', executions: 1 });
    } finally { await Promise.allSettled([engine.close()]); }
  });
  it('returns UNKNOWN without permitting rearm when all dispatch acknowledgement paths are lost', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job');
    vi.spyOn(adapter, 'arm').mockImplementation(async () => {
      adapter.statuses.set('job', { jobId: 'job', state: 'VERIFIED', executions: 1, updatedAt: 101 });
      throw new FlashActError('ADAPTER_ERROR', 'Arm acknowledgement lost');
    });
    vi.spyOn(adapter, 'cancel').mockRejectedValue(new FlashActError('ADAPTER_ERROR', 'Cancellation transport lost'));
    vi.spyOn(adapter, 'getStatus').mockRejectedValue(new FlashActError('ADAPTER_ERROR', 'Status transport lost'));
    try {
      // When
      await expect(engine.armJob('job')).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
      const result = await engine.getResult('job');
      // Then
      expect(result.state).toBe('UNKNOWN');
      await expect(engine.armJob('job')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    } finally { await Promise.allSettled([engine.close()]); }
  });
  it('preserves the observed execution count when reconciliation loses a dispatched job', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job');
    vi.spyOn(adapter, 'arm').mockRejectedValue(new FlashActError('ADAPTER_ERROR', 'Arm acknowledgement lost'));
    vi.spyOn(adapter, 'getStatus').mockResolvedValueOnce({ jobId: 'job', state: 'DISPATCHED', executions: 1, updatedAt: 101 })
      .mockRejectedValue(new FlashActError('ADAPTER_ERROR', 'Status transport lost'));
    vi.spyOn(adapter, 'cancel').mockRejectedValue(new FlashActError('ADAPTER_ERROR', 'Cancellation transport lost'));
    try {
      // When
      await expect(engine.armJob('job')).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
      const result = await engine.getResult('job');
      // Then
      expect(result).toMatchObject({ state: 'UNKNOWN', executions: 1 });
    } finally { await Promise.allSettled([engine.close()]); }
  });
  it('reports FAILED when installation fails before any arm command', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job');
    vi.spyOn(adapter, 'installRuntime').mockRejectedValue(new FlashActError('ADAPTER_ERROR', 'Installation rejected'));
    try {
      // When
      await expect(engine.armJob('job')).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
      const result = await engine.getResult('job');
      // Then
      expect(result).toMatchObject({ state: 'FAILED', executions: 0 });
      expect(adapter.statuses.size).toBe(0);
    } finally { await engine.close(); }
  });
  it('retains known dispatch evidence when a cancellation response contradicts the execution count', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job'); await engine.armJob('job');
    adapter.statuses.set('job', { jobId: 'job', state: 'DISPATCHED', executions: 1, updatedAt: 101 });
    try {
      // When
      const result = await engine.cancelJob('job');
      // Then
      expect(result).toMatchObject({ state: 'UNKNOWN', executions: 1 });
    } finally { await engine.close(); }
  });
  it('retains a completed outcome when closing before the host has polled it', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job'); await engine.armJob('job');
    adapter.statuses.set('job', { jobId: 'job', state: 'VERIFIED', executions: 1, updatedAt: 101 });
    // When
    await engine.close();
    // Then
    expect(engine.logs().at(-1)).toMatchObject({ state: 'VERIFIED', executions: 1 });
    expect(adapter.cleanup).toEqual(['disconnect']);
  });
  it('records UNKNOWN and disconnects when shutdown cancellation and status are unreachable', async () => {
    // Given
    const { engine, adapter } = fixture(); await engine.createJob(plan); await engine.validateJob('job'); await engine.armJob('job');
    vi.spyOn(adapter, 'cancel').mockRejectedValue(new FlashActError('ADAPTER_ERROR', 'Cancellation transport lost'));
    vi.spyOn(adapter, 'getStatus').mockRejectedValue(new FlashActError('ADAPTER_ERROR', 'Status transport lost'));
    // When
    await engine.close();
    // Then
    expect(engine.logs().at(-1)?.state).toBe('UNKNOWN');
    expect(adapter.cleanup).toEqual(['disconnect']);
  });
});

describe('MCP SDK client', () => {
  it('enumerates all ten operations when connected', async () => {
    // Given
    const { engine } = fixture(); const server = createMcpServer(engine); const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    try {
      // When
      const result = await client.listTools();
      // Then
      expect(result.tools.map(tool => tool.name).sort()).toEqual([
        'flashact_list_backends', 'flashact_list_tabs', 'flashact_inspect_target', 'flashact_create_job',
        'flashact_validate_job', 'flashact_arm_job', 'flashact_get_status', 'flashact_cancel_job',
        'flashact_get_result', 'flashact_run_benchmark',
      ].sort());
    } finally { await client.close(); await server.close(); await engine.close(); }
  });
  it('validates and arms a plan when using real SDK transport', async () => {
    // Given
    const { engine } = fixture(); const server = createMcpServer(engine); const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    await client.callTool({ name: 'flashact_create_job', arguments: { plan } });
    await client.callTool({ name: 'flashact_validate_job', arguments: { jobId: 'job' } });
    try {
      // When
      const result = await client.callTool({ name: 'flashact_arm_job', arguments: { jobId: 'job' } });
      // Then
      expect(result.isError).not.toBe(true);
      expect((await engine.getStatus('job')).state).toBe('WAITING');
    } finally { await client.close(); await server.close(); await engine.close(); }
  });
  it('returns a tool error when the plan violates the single-shot contract', async () => {
    // Given
    const { engine } = fixture(); const server = createMcpServer(engine); const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    try {
      // When
      const result = await client.callTool({ name: 'flashact_create_job', arguments: { plan: { ...plan, maxExecutions: 2 } } });
      // Then
      expect(result.isError).toBe(true); expect(engine.jobIds()).toEqual([]);
    } finally { await client.close(); await server.close(); await engine.close(); }
  });
});
