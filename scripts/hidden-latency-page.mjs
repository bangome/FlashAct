// Serialized whole: the measured path stays inside the real fixture document.
export async function hiddenTrial(options) {
  const runtime = globalThis.__flashactRuntime;
  const fixture = globalThis.__flashactFixture;
  const now = () => performance.timeOrigin + performance.now();
  const snapshot = () => ({ epochMs: now(), wallMs: Date.now(),
    visibilityState: document.visibilityState, hidden: document.hidden });
  const audit = () => globalThis.__controlledVisibilityAudit.slice(options.auditStartIndex);
  const hidden = value => value.hidden && value.visibilityState === 'hidden';
  const row = { ...options, documentId: runtime.documentId, clicks: [], cancellation: 'not-installed' };
  const button = document.querySelector('#reserve');
  const descriptor = Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype, 'disabled');
  let stimulusTimer, deadlineTimer, installed = false, setterInstalled = false, finished = false, complete;
  const outcome = new Promise(resolve => { complete = reason => {
    if (!finished) { finished = true; resolve(reason); }
  }; });
  const click = event => { if (event.target === button) complete('click'); };
  const visibility = () => { if (!document.hidden) complete('visibility-lost'); };
  try {
    row.visibilityBefore = snapshot();
    if (!hidden(row.visibilityBefore) || !audit().length || audit().some(event =>
      event.kind !== 'visibilitychange' || event.isTrusted !== true || !hidden(event))) {
      throw new Error('Measurement requires continuous trusted native hidden state');
    }
    fixture.reset(options.jobId, options.scenario === 'scheduled');
    if (options.scenario === 'reactive') {
      Object.defineProperty(button, 'disabled', {
        configurable: true, get() { return descriptor.get.call(this); },
        set(value) {
          const beforeEpochMs = now();
          descriptor.set.call(this, value);
          if (value === false) row.actualStimulus = { beforeEpochMs, epochMs: now(), wallMs: Date.now() };
        },
      });
      setterInstalled = true;
    }
    const beforePageEpochMs = now(), wallEpochMs = Date.now(), afterPageEpochMs = now();
    row.anchors = { beforePageEpochMs, wallEpochMs, afterPageEpochMs };
    row.targetWallEpochMs = wallEpochMs + options.horizonMs;
    row.targetEpochMs = (beforePageEpochMs + afterPageEpochMs) / 2 + options.horizonMs;
    row.targetUncertaintyMs = 1 + (afterPageEpochMs - beforePageEpochMs) / 2;
    row.plan = { schemaVersion: '1.0', jobId: options.jobId, name: options.jobId, backend: 'playwright',
      target: { tabId: 'owned-hidden-fixture', selector: '#reserve', url: location.href },
      trigger: options.scenario === 'scheduled' ? { type: 'SCHEDULED', at: row.targetWallEpochMs }
        : { type: 'ELEMENT_ENABLE', selector: '#reserve' },
      action: { type: 'click' }, timezone: 'UTC', expiresAt: row.targetWallEpochMs + 3000,
      maxExecutions: 1, verification: { timeoutMs: 1000 },
      guards: { approvedUrl: location.href, allowIrreversible: false } };
    // Install the exact signals before ARM, including synchronous dispatch.
    document.addEventListener('click', click);
    document.addEventListener('visibilitychange', visibility);
    row.installReceipt = runtime.install(row.plan);
    installed = true;
    row.armBefore = snapshot();
    row.armReceipt = runtime.arm(options.jobId);
    row.armAfter = snapshot();
    const terminal = new Set(['VERIFIED', 'UNKNOWN', 'FAILED', 'EXPIRED', 'CANCELLED', 'INVALIDATED']);
    if (terminal.has(row.armReceipt.state)) complete('arm-terminal');
    if (options.scenario === 'reactive' && !finished) {
      row.intendedStimulusEpochMs = now() + options.horizonMs;
      stimulusTimer = setTimeout(() => fixture.enable(), options.horizonMs);
    }
    row.collectionDeadlineWallEpochMs = row.targetWallEpochMs + 4000;
    if (!finished) deadlineTimer = setTimeout(() => complete('collection-deadline'),
      Math.max(1, row.collectionDeadlineWallEpochMs - Date.now()));
    row.collectionReason = await outcome;
    // The click task (fixture ledger and runtime verification) finishes before
    // this continuation. No extra polling timer changes hidden scheduling.
    row.status = runtime.status(options.jobId);
    row.clicks = fixture.ledger.filter(event => event.jobId === options.jobId);
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
    row.clicks = fixture.ledger.filter(event => event.jobId === options.jobId);
  } finally {
    clearTimeout(stimulusTimer); clearTimeout(deadlineTimer);
    document.removeEventListener('click', click);
    document.removeEventListener('visibilitychange', visibility);
    if (setterInstalled) delete button.disabled;
    if (installed) {
      try { row.cancelReceipt = runtime.cancel(options.jobId); row.cancellation = 'acknowledged'; }
      catch (error) { row.cancellation = 'failed'; row.cancelError = String(error); }
    }
  }
  row.visibilityAfter = snapshot();
  row.visibilityAudit = audit();
  row.validVisibility = hidden(row.visibilityBefore) && hidden(row.visibilityAfter)
    && row.visibilityAudit.length > 0 && row.visibilityAudit.every(event =>
      event.kind === 'visibilitychange' && event.isTrusted === true && hidden(event));
  row.E0 = row.actualStimulus?.epochMs ?? null;
  row.E1 = options.scenario === 'reactive' && row.E0 !== null && row.status?.timing?.observerEpochMs >= row.E0
    ? row.status.timing.observerEpochMs : null;
  row.E2 = row.clicks[0]?.epochMs ?? null;
  row.actualStimulusLatenessMs = row.E0 === null ? null : row.E0 - row.intendedStimulusEpochMs;
  row.latencyMs = row.E2 === null || (options.scenario === 'reactive' && row.E0 === null)
    ? null : row.E2 - (options.scenario === 'reactive' ? row.E0 : row.targetEpochMs);
  row.success = row.validVisibility && row.status?.state === 'VERIFIED' && row.status.executions === 1
    && row.clicks.length === 1 && row.cancellation === 'acknowledged' && Number.isFinite(row.latencyMs)
    && (options.scenario === 'scheduled' || Number.isFinite(row.E0));
  return row;
}
