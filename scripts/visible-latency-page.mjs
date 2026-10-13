// Serialized whole: every dependency in the measured path lives in this function.
export async function visibleTrial(options) {
  const runtime = globalThis.__flashactRuntime;
  const fixture = globalThis.__flashactFixture;
  const now = () => performance.timeOrigin + performance.now();
  const snapshot = () => ({ epochMs: now(), wallMs: Date.now(),
    visibilityState: document.visibilityState, hidden: document.hidden });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const row = { ...options, documentId: runtime.documentId, clicks: [], cancellation: 'pending' };
  globalThis.__visibleTrial = row;
  const button = document.querySelector('#reserve');
  const descriptor = Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype, 'disabled');
  let stimulusTimer;
  let installed = false;
  try {
    row.visibilityBefore = snapshot();
    if (document.hidden || globalThis.__visibleAudit.some(event => event.hidden)) {
      throw new Error('Native hidden state: abort visible experiment');
    }
    fixture.reset(options.jobId, options.scenario === 'scheduled');
    // Record immediately around the real native setter, not the intended timer deadline.
    if (options.scenario === 'reactive') Object.defineProperty(button, 'disabled', {
      configurable: true, get() { return descriptor.get.call(this); },
      set(value) {
        const beforeEpochMs = now();
        descriptor.set.call(this, value);
        if (value === false) row.actualStimulus = { beforeEpochMs, epochMs: now(), wallMs: Date.now() };
      },
    });
    const beforePageEpochMs = now();
    const wallEpochMs = Date.now();
    const afterPageEpochMs = now();
    row.anchors = { beforePageEpochMs, wallEpochMs, afterPageEpochMs };
    row.targetWallEpochMs = wallEpochMs + options.horizonMs;
    row.targetEpochMs = (beforePageEpochMs + afterPageEpochMs) / 2 + options.horizonMs;
    row.targetUncertaintyMs = 1 + (afterPageEpochMs - beforePageEpochMs) / 2;
    const plan = { schemaVersion: '1.0', jobId: options.jobId, name: options.jobId,
      backend: 'playwright', target: { tabId: 'owned-fixture', selector: '#reserve', url: location.href },
      trigger: options.scenario === 'scheduled' ? { type: 'SCHEDULED', at: row.targetWallEpochMs }
        : { type: 'ELEMENT_ENABLE', selector: '#reserve' },
      action: { type: 'click' }, timezone: 'UTC', expiresAt: row.targetWallEpochMs + 3000,
      maxExecutions: 1, verification: { timeoutMs: 1000 },
      guards: { approvedUrl: location.href, allowIrreversible: false } };
    row.plan = plan;
    row.installReceipt = runtime.install(plan);
    installed = true;
    row.armBefore = snapshot();
    row.armReceipt = runtime.arm(options.jobId);
    row.armAfter = snapshot();
    if (options.scenario === 'reactive') {
      row.intendedStimulusTime = now() + 1000;
      row.targetEpochMs = row.intendedStimulusTime;
      // Authored page timer starts after ARM; no host IPC drives enable or click.
      stimulusTimer = setTimeout(() => fixture.enable(), 1000);
    }
    row.collectionDeadlineEpochMs = row.targetEpochMs + 4000;
    const terminal = new Set(['VERIFIED', 'UNKNOWN', 'FAILED', 'EXPIRED', 'CANCELLED', 'INVALIDATED']);
    while (!terminal.has(runtime.status(options.jobId).state) && now() < row.collectionDeadlineEpochMs) {
      if (document.hidden || globalThis.__visibleAudit.some(event => event.hidden)) {
        throw new Error('Native hidden transition: abort visible experiment');
      }
      await pause(5);
    }
    // One additional task/microtask observer delivery after the terminal receipt.
    await pause(1);
    row.status = runtime.status(options.jobId);
    row.clicks = fixture.ledger.filter(click => click.jobId === options.jobId);
    row.visibilityAfter = snapshot();
    row.visibilityAudit = [...globalThis.__visibleAudit];
    row.validVisibility = !row.visibilityAfter.hidden && !row.visibilityAudit.some(event => event.hidden);
    row.E0 = row.actualStimulus?.epochMs ?? null;
    row.E1 = options.scenario === 'reactive' && row.status.timing?.observerEpochMs >= row.E0
      && row.E0 !== null ? row.status.timing.observerEpochMs : null;
    row.E2 = row.clicks[0]?.epochMs ?? null;
    row.actualStimulusLatenessMs = row.E0 === null ? null : row.E0 - row.intendedStimulusTime;
    row.latencyMs = row.E2 === null || (options.scenario === 'reactive' && row.E0 === null)
      ? null : row.E2 - (options.scenario === 'reactive' ? row.E0 : row.targetEpochMs);
    row.success = row.validVisibility && row.status.state === 'VERIFIED' && row.clicks.length === 1;
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
    row.success = false;
    row.clicks = fixture.ledger.filter(click => click.jobId === options.jobId);
    row.visibilityAfter = snapshot();
    row.visibilityAudit = [...globalThis.__visibleAudit];
    row.validVisibility = !row.visibilityAfter.hidden && !row.visibilityAudit.some(event => event.hidden);
  } finally {
    clearTimeout(stimulusTimer);
    if (options.scenario === 'reactive') delete button.disabled;
    if (installed) {
      try { row.cancelReceipt = runtime.cancel(options.jobId); row.cancellation = 'cancelled'; }
      catch (error) { row.cancellation = 'failed'; row.cancelError = String(error); }
    } else row.cancellation = 'not-installed';
  }
  return row;
}

export function summarizeVisible(rows) {
  const delays = rows.filter(row => row.validVisibility && row.latencyMs !== null && row.latencyMs !== undefined)
    .map(row => row.latencyMs).sort((a, b) => a - b);
  const middle = Math.floor(delays.length / 2);
  return { count: rows.length, successes: rows.filter(row => row.success).length,
    failures: rows.filter(row => !row.success).length, measured: delays.length,
    dupCount: rows.reduce((total, row) => total + Math.max(0, row.clicks.length - 1), 0),
    earlyWallGuardViolations: rows.filter(row => row.scenario === 'scheduled'
      && row.clicks.some(click => click.wallMs < row.targetWallEpochMs)).length,
    negativeWithinUncertainty: rows.filter(row => row.scenario === 'scheduled'
      && row.latencyMs < 0 && row.latencyMs >= -row.targetUncertaintyMs).length,
    negativeBeyondUncertainty: rows.filter(row => row.latencyMs < -(row.scenario === 'scheduled'
      ? row.targetUncertaintyMs : (row.actualStimulus?.epochMs - row.actualStimulus?.beforeEpochMs))).length,
    observedOver50ms: delays.filter(delay => delay > 50).length,
    meanMs: delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null,
    medianMs: delays.length ? (delays[middle] + delays[Math.floor((delays.length - 1) / 2)]) / 2 : null,
    minMs: delays[0] ?? null, maxMs: delays.at(-1) ?? null };
}
