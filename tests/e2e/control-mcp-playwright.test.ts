import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { z } from 'zod';
import { browserTabsSchema, jobStatusSchema, targetInfoSchema } from '../../src/core/schema.js';
import type { ExecutionPlan } from '../../src/core/types.js';

it('executes and cancels jobs through launched Playwright MCP and cleans up on stdin EOF', async () => {
  // Given
  const home = await mkdtemp(join(tmpdir(), 'flashact-mcp-playwright-'));
  let clicks = 0;
  let receivedClick: () => void = () => undefined;
  const clicked = new Promise<void>(resolveClick => { receivedClick = resolveClick; });
  const fixture = createServer((req, res) => {
    if (req.url === '/clicked') { clicks++; res.end(); receivedClick(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<button id="reserve" onclick="document.body.insertAdjacentHTML(\'beforeend\',\'<span id=done>done</span>\'); fetch(\'/clicked\')">reserve</button><button id="pending" disabled>pending</button>');
  });
  await new Promise<void>(resolveListen => fixture.listen(0, '127.0.0.1', resolveListen));
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Fixture has no port');
  const url = `http://127.0.0.1:${address.port}/`;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli/index.js'), 'mcp', '--launch', '--headless', '--url', url],
    env: { ...process.env, FLASHACT_HOME: home }, stderr: 'pipe' });
  const client = new Client({ name: 'real-browser-e2e', version: '1' });
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, name).not.toBe(true);
    const content = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })) }).parse(result).content[0];
    if (!content) throw new Error('MCP tool returned no content');
    const value: unknown = JSON.parse(content.text);
    return value;
  };
  try {
    await client.connect(transport);
    const tabs = browserTabsSchema.parse(await call('flashact_list_tabs', { backend: 'playwright' }));
    const tab = tabs.find(item => item.url === url);
    if (!tab) throw new Error('MCP did not prepare the owned fixture tab');
    const target = targetInfoSchema.parse(await call('flashact_inspect_target', { backend: 'playwright', tabId: tab.id, selector: '#reserve' }));
    const plan: ExecutionPlan = { schemaVersion: '1.0', jobId: 'dispatch', name: 'owned fixture', backend: 'playwright',
      target: { tabId: tab.id, selector: '#reserve', url }, trigger: { type: 'ELEMENT_ENABLE', selector: '#reserve' },
      action: { type: 'click' }, timezone: 'UTC', expiresAt: Date.now() + 60000, maxExecutions: 1,
      verification: { selector: '#done', timeoutMs: 1000 }, guards: { approvedUrl: url, allowIrreversible: false } };
    const pending: ExecutionPlan = { ...plan, jobId: 'pending', target: { ...plan.target, selector: '#pending' },
      trigger: { type: 'ELEMENT_ENABLE', selector: '#pending' } };
    await call('flashact_create_job', { plan }); await call('flashact_validate_job', { jobId: plan.jobId });
    await call('flashact_create_job', { plan: pending }); await call('flashact_validate_job', { jobId: pending.jobId });
    // When
    await call('flashact_arm_job', { jobId: plan.jobId });
    await Promise.race([clicked, new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No fixture click receipt')), 10000); timer.unref();
      void clicked.then(() => clearTimeout(timer));
    })]);
    const dispatched = jobStatusSchema.parse(await call('flashact_cancel_job', { jobId: plan.jobId }));
    const status = jobStatusSchema.parse(await call('flashact_get_status', { jobId: plan.jobId }));
    await call('flashact_arm_job', { jobId: pending.jobId });
    const waiting = jobStatusSchema.parse(await call('flashact_get_status', { jobId: pending.jobId }));
    const cancelled = jobStatusSchema.parse(await call('flashact_cancel_job', { jobId: pending.jobId }));
    await call('flashact_create_job', { plan: { ...pending, jobId: 'eof-pending' } });
    await call('flashact_validate_job', { jobId: 'eof-pending' }); await call('flashact_arm_job', { jobId: 'eof-pending' });
    await client.close();
    // Then
    expect(target).toMatchObject({ url, count: 1, enabled: true });
    expect(dispatched).toMatchObject({ state: 'VERIFIED', executions: 1 });
    expect(status).toMatchObject({ state: 'VERIFIED', executions: 1 });
    expect(waiting).toMatchObject({ state: 'WAITING', executions: 0 });
    expect(cancelled).toMatchObject({ state: 'CANCELLED', executions: 0 });
    expect(clicks).toBe(1);
    await expect(access(join(home, 'engine.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await client.close();
    await new Promise<void>((resolveClose, reject) => fixture.close(error => error ? reject(error) : resolveClose()));
    await rm(home, { recursive: true, force: true });
  }
}, 25000);
