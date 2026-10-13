import type { Page } from 'playwright';
import type { BrowserAdapter } from '../adapters/browser-adapter.js';
import type { ExecutionPlan } from '../core/types.js';

export async function runLifecycle(adapter: BrowserAdapter, page: Page) {
  await adapter.disconnect();
  await adapter.connect();
  const tab = (await adapter.listTabs()).find(tab => tab.url === page.url());
  if (!tab) throw new RangeError('Owned fixture tab missing after reconnect');
  await adapter.evaluate('globalThis.__flashactFixture.reset("close-pending", true)');
  const plan: ExecutionPlan = {
    schemaVersion: '1.0', jobId: 'close-pending', name: 'Close pending benchmark job', backend: 'playwright',
    target: {tabId: tab.id, selector: '#reserve', url: page.url()},
    trigger: {type: 'SCHEDULED', at: Date.now() + 60000}, action: {type: 'click'}, timezone: 'UTC',
    expiresAt: Date.now() + 120000, maxExecutions: 1, verification: {timeoutMs: 1000},
    guards: {approvedUrl: page.url(), allowIrreversible: false},
  };
  await adapter.installRuntime(plan);
  await adapter.arm(plan);
  const before = await adapter.getStatus(plan.jobId);
  await page.close();
  const after = await adapter.getStatus(plan.jobId);
  return {reconnection: 'adapter disconnect/connect on same owned page', before, after,
    passed: before.state === 'WAITING' && after.state === 'INVALIDATED' && after.executions === 0};
}
