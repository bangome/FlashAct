import { describe, expect, it } from 'vitest';
import { runtimeSource, installExpression } from '../../dist/runtime/index.js';
import { parsePlan } from '../../src/core/schema.js';
import { capturedPlans } from '../../scripts/service-use-proxy.mjs';

const plan = {
  schemaVersion: '1.0', jobId: 'captured', name: 'actual argument', backend: 'playwright',
  target: { tabId: 'owned', selector: '[data-value="))"]', url: 'http://127.0.0.1:1/task/captured' },
  trigger: { type: 'SCHEDULED', at: 100 }, action: { type: 'click' }, timezone: 'UTC',
  expiresAt: 200, maxExecutions: 1, verification: { selector: '#ack', timeoutMs: 5000 },
  guards: { approvedUrl: 'http://127.0.0.1:1/task/captured', allowIrreversible: false },
};

describe('actual CDP install argument capture', () => {
  it('decodes the shipped expression without greedy selector parsing', () => {
    // Given
    const protocol = [{ direction: 'send', message: { params: { arguments: [{ value: installExpression(plan) }] } } }];
    // When
    const captured = capturedPlans(protocol, runtimeSource(), parsePlan);
    // Then
    expect(captured).toEqual([plan]);
  });

  it('ignores responses and expressions from a different shipped runtime', () => {
    // Given
    const protocol = [
      { direction: 'receive', message: { params: { expression: installExpression(plan) } } },
      { direction: 'send', message: { params: { expression: 'JSON.stringify((other).install({}))' } } },
    ];
    // When
    const captured = capturedPlans(protocol, runtimeSource(), parsePlan);
    // Then
    expect(captured).toEqual([]);
  });

  it('rejects an unexpected expression suffix rather than inventing a plan', () => {
    // Given
    const protocol = [{ direction: 'send', message: { params: { expression: `${installExpression(plan)};other()` } } }];
    // When / Then
    expect(() => capturedPlans(protocol, runtimeSource(), parsePlan)).toThrow();
  });
});
