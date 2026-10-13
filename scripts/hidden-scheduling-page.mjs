// Fixture-only external-dispatch baseline. Not a substitute for runtime guards.
export function prepareExternal(options) {
  const fixture = globalThis.__flashactFixture;
  const now = () => performance.timeOrigin + performance.now();
  const audit = globalThis.__controlledVisibilityAudit.slice(options.auditStartIndex);
  if (!document.hidden || document.visibilityState !== 'hidden'
    || !audit.length || audit.some(event => !event.isTrusted || !event.hidden)) {
    throw new Error('External comparison requires genuine continuous hidden state');
  }
  fixture.reset(options.jobId, true);
  const button = document.querySelector('#reserve');
  const beforePageEpochMs = now(), wallEpochMs = Date.now(), afterPageEpochMs = now();
  const row = { ...options, path: 'host-cdp', anchors: { beforePageEpochMs, wallEpochMs, afterPageEpochMs },
    targetWallEpochMs: wallEpochMs + options.horizonMs,
    targetEpochMs: (beforePageEpochMs + afterPageEpochMs) / 2 + options.horizonMs,
    targetUncertaintyMs: 1 + (afterPageEpochMs - beforePageEpochMs) / 2,
    approvedUrl: location.href, clicks: [] };
  globalThis.__externalScheduled = { row, button, dispatched: false };
  return row;
}

export function dispatchExternal(jobId) {
  const state = globalThis.__externalScheduled;
  const fixture = globalThis.__flashactFixture;
  const now = () => performance.timeOrigin + performance.now();
  if (state.row.jobId !== jobId || state.dispatched) throw new Error('External baseline dispatch is single-shot');
  const row = state.row;
  row.visibilityBefore = { hidden: document.hidden, visibilityState: document.visibilityState };
  row.visibilityAudit = globalThis.__controlledVisibilityAudit.slice(row.auditStartIndex);
  row.receivedEpochMs = now();
  row.dispatchWallMs = Date.now();
  if (!row.visibilityBefore.hidden || row.visibilityBefore.visibilityState !== 'hidden'
    || row.visibilityAudit.some(event => !event.isTrusted || !event.hidden)
    || row.dispatchWallMs < row.targetWallEpochMs || row.dispatchWallMs >= row.targetWallEpochMs + 3000
    || location.href !== row.approvedUrl || !state.button.isConnected
    || document.querySelectorAll('#reserve').length !== 1 || document.querySelector('#reserve') !== state.button
    || state.button.disabled) throw new Error('External fixture baseline guard failed');
  state.dispatched = true;
  HTMLElement.prototype.click.call(state.button);
  row.clicks = fixture.ledger.filter(event => event.jobId === jobId);
  row.visibilityAfter = { hidden: document.hidden, visibilityState: document.visibilityState };
  row.validVisibility = row.visibilityBefore.hidden && row.visibilityAfter.hidden
    && row.visibilityAudit.every(event => event.isTrusted && event.hidden);
  row.E2 = row.clicks[0]?.epochMs ?? null;
  row.latencyMs = row.E2 === null ? null : row.E2 - row.targetEpochMs;
  row.success = row.validVisibility && row.clicks.length === 1
    && row.clicks[0].trusted === false && Number.isFinite(row.latencyMs);
  row.cancellation = 'host-timer-retired';
  return row;
}

// Actual compiled-runtime comparison. Subscribe before ARM; never poll status.
export function prepareGuarded(options) {
  const fixture = globalThis.__flashactFixture;
  const now = () => performance.timeOrigin + performance.now();
  const audit = globalThis.__controlledVisibilityAudit.slice(options.auditStartIndex);
  if (!document.hidden || !audit.length || audit.some(event => !event.isTrusted || !event.hidden)) {
    throw new Error('Guarded comparison requires genuine continuous hidden state');
  }
  fixture.reset(options.jobId, true);
  const button = document.querySelector('#reserve');
  const beforePageEpochMs = now(), wallEpochMs = Date.now(), afterPageEpochMs = now();
  const base = { ...options, anchors: { beforePageEpochMs, wallEpochMs, afterPageEpochMs },
    targetWallEpochMs: wallEpochMs + options.horizonMs,
    targetEpochMs: (beforePageEpochMs + afterPageEpochMs) / 2 + options.horizonMs,
    targetUncertaintyMs: 1 + (afterPageEpochMs - beforePageEpochMs) / 2,
    visibilityBefore: { hidden: document.hidden, visibilityState: document.visibilityState } };
  globalThis.__comparisonWakeEntry = null;
  globalThis.__comparisonCompleted = new Promise(resolve => {
    button.addEventListener('click', () => queueMicrotask(() => {
      const clicks = fixture.ledger.filter(event => event.jobId === options.jobId);
      const status = globalThis.__flashactRuntime.status(options.jobId);
      const visibilityAfter = { hidden: document.hidden, visibilityState: document.visibilityState };
      const visibilityAudit = globalThis.__controlledVisibilityAudit.slice(options.auditStartIndex);
      const validVisibility = base.visibilityBefore.hidden && visibilityAfter.hidden
        && visibilityAudit.every(event => event.isTrusted && event.hidden);
      const E2 = clicks[0]?.epochMs ?? null;
      resolve({ ...base, status, clicks, E2, latencyMs: E2 === null ? null : E2 - base.targetEpochMs,
        wakeReceivedEpochMs: globalThis.__comparisonWakeEntry,
        visibilityAfter, visibilityAudit, validVisibility,
        success: validVisibility && status.state === 'VERIFIED' && status.executions === 1
          && clicks.length === 1 && clicks[0].trusted === false,
        dispatchWallMs: clicks[0]?.wallMs ?? null, cancellation: 'runtime-terminal-observed' });
    }), { once: true });
  });
  return { ...base, plan: { schemaVersion: '1.0', jobId: options.jobId,
    name: `Hidden guarded ${options.path}`, backend: 'playwright',
    target: { tabId: 'owned-hidden-comparison', selector: '#reserve', url: location.href, watchRoot: 'body' },
    trigger: { type: 'SCHEDULED', at: base.targetWallEpochMs }, action: { type: 'click' }, timezone: 'UTC',
    expiresAt: base.targetWallEpochMs + 3000, maxExecutions: 1, verification: { timeoutMs: 1000 },
    guards: { approvedUrl: location.href, allowIrreversible: false } } };
}
