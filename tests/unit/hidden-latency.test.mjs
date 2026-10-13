import { afterEach, describe, expect, it, vi } from 'vitest';
import { hiddenTrial } from '../../scripts/hidden-latency-page.mjs';
import { finishHiddenReport, hiddenRowSchema } from '../../scripts/hidden-latency-report.mjs';
import { measurementFixture } from '../fixtures/hidden-latency-fixture.mjs';

const hidden = () => ({ epochMs: 10000, wallMs: 10000, hidden: true, visibilityState: 'hidden' });
const auditEvent = () => ({ ...hidden(), kind: 'visibilitychange', isTrusted: true });
const receipt = (jobId, state, executions) => ({ jobId, state, executions, updatedAt: 10000 });
const sample = (jobId, scenario, horizonMs, latencyMs = 2) => ({
  jobId, scenario, horizonMs, validVisibility: true, success: true, latencyMs,
  visibilityBefore: hidden(), visibilityAfter: hidden(), visibilityAudit: [auditEvent()],
  targetEpochMs: 10000, targetWallEpochMs: 10000, targetUncertaintyMs: 1,
  clicks: [{ jobId, epochMs: 10000 + latencyMs, wallMs: 10000 + Math.max(0, latencyMs), trusted: false }],
  cancellation: 'acknowledged', status: receipt(jobId, 'VERIFIED', 1),
  armReceipt: receipt(jobId, 'ARMED', 0), cancelReceipt: receipt(jobId, 'CANCELLED', 1),
  E0: scenario === 'reactive' ? 10000 : null, E1: scenario === 'reactive' ? 10001 : null,
  E2: 10000 + latencyMs, actualStimulus: { beforeEpochMs: 9999, epochMs: 10000 },
});
const nativeObservation = () => ({ agree: true, cdp: hidden(), nativeBounds: { windowState: 'minimized' } });
function completeInput() {
  const samples = ['scheduled', 'reactive'].flatMap(scenario =>
    Array.from({ length: 20 }, (_, index) =>
      sample(`${scenario}-${index}`, scenario, scenario === 'scheduled' ? 12 : 1000)));
  return {
    probe: { status: 'HIDDEN_GATE_VERIFIED', nativeGate: { passed: true },
      provenance: { passed: true, targetWindowBound: true }, cleanupSuccess: true,
      hashManifest: { unchanged: true }, lifecycle: { stopReason: null }, errors: [] },
    measurement: { samples, attemptedTrials: 40, activeTrial: null,
      beforeHidden: nativeObservation(), afterHidden: nativeObservation(),
      visibilityAudit: [auditEvent()], restoration: { status: 'restored', boundsMatch: true },
      finalLedger: samples.flatMap(row => row.clicks) },
  };
}
const options = (scenario = 'scheduled') => ({
  jobId: `unit-${scenario}`, scenario, horizonMs: scenario === 'scheduled' ? 12 : 1000, auditStartIndex: 0,
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('hidden report completion (unit input evidence, not native proof)', () => {
  it('leaves a failed hidden gate blocked with zero rows and no latency', () => {
    // Given
    const { probe, measurement } = completeInput();
    probe.nativeGate.passed = false;
    measurement.samples = [];
    measurement.attemptedTrials = 0;
    measurement.finalLedger = [];
    // When
    const report = finishHiddenReport(probe, measurement);
    // Then
    expect(report).toMatchObject({ status: 'BLOCKED_OR_PARTIAL', completedTrials: 0,
      attemptedTrials: 0, samples: [], summary: { count: 0, measured: 0, meanMs: null, minMs: null } });
  });

  it('requires the complete two-cell matrix and preserves all forty ledger rows', () => {
    // Given
    const { probe, measurement } = completeInput();
    for (const row of measurement.samples) expect(hiddenRowSchema.safeParse(row).success).toBe(true);
    // When
    const report = finishHiddenReport(probe, measurement);
    // Then
    expect(report).toMatchObject({ status: 'HIDDEN_MEASURED', plannedTrials: 40,
      completedTrials: 40, hiddenTrials: 40, coverage: true,
      summary: { successes: 40, measured: 40, meanMs: 2 } });
    expect(report.cells).toMatchObject([
      { scenario: 'scheduled', horizonMs: 12, count: 20, successes: 20, measured: 20 },
      { scenario: 'reactive', horizonMs: 1000, count: 20, successes: 20, measured: 20 },
    ]);
    expect(report.finalLedger).toEqual(measurement.finalLedger);
    expect(new Set(report.samples.map(row => row.jobId)).size).toBe(40);
  });

  it.each([
    ['gate false', (p) => { p.nativeGate.passed = false; }],
    ['gate status', (p) => { p.status = 'BLOCKED_OR_PARTIAL'; }],
    ['provenance', (p) => { p.provenance.passed = false; }],
    ['window binding', (p) => { p.provenance.targetWindowBound = false; }],
    ['cleanup', (p) => { p.cleanupSuccess = false; }],
    ['preservation', (p) => { p.hashManifest.unchanged = false; }],
    ['stop', (p) => { p.lifecycle.stopReason = 'driver-lost'; }],
    ['probe error', (p) => { p.errors.push({ code: 'UNKNOWN' }); }],
    ['attempt count', (p, m) => { m.attemptedTrials = 39; }],
    ['in-flight unknown', (p, m) => { m.activeTrial = { jobId: 'pending', outcome: 'UNKNOWN' }; }],
    ['missing scheduled trial', (p, m) => { m.samples.splice(0, 1); }],
    ['missing reactive trial', (p, m) => { m.samples.pop(); }],
    ['wrong scheduled horizon', (p, m) => { m.samples[0].horizonMs = 13; }],
    ['wrong reactive horizon', (p, m) => { m.samples[20].horizonMs = 999; }],
    ['duplicate job ID', (p, m) => { m.samples[1].jobId = m.samples[0].jobId; }],
    ['missing final ledger', (p, m) => { m.finalLedger = []; }],
    ['duplicate ledger job', (p, m) => { m.finalLedger[1] = m.finalLedger[0]; }],
    ['unacknowledged cancellation', (p, m) => { m.samples[0].cancellation = 'failed'; }],
    ['missing cancellation receipt', (p, m) => { delete m.samples[0].cancelReceipt; }],
    ['missing arm receipt', (p, m) => { delete m.samples[0].armReceipt; }],
    ['unknown row', (p, m) => { m.samples[0].status.state = 'UNKNOWN'; }],
    ['no execution', (p, m) => { m.samples[0].status.executions = 0; }],
    ['no numeric latency', (p, m) => { m.samples[0].latencyMs = null; }],
    ['missing click', (p, m) => { m.samples[0].clicks = []; m.samples[0].latencyMs = null; }],
    ['invalid visibility', (p, m) => { m.samples[0].validVisibility = false; }],
    ['visible interruption', (p, m) => { m.visibilityAudit.push({ ...auditEvent(), hidden: false, visibilityState: 'visible' }); }],
    ['missing audit', (p, m) => { m.visibilityAudit = []; }],
    ['untrusted audit', (p, m) => { m.visibilityAudit[0].isTrusted = false; }],
    ['wrong audit kind', (p, m) => { m.visibilityAudit[0].kind = 'unit-emulation'; }],
    ['interrupted row audit', (p, m) => {
      m.samples[0].visibilityAudit.push({ ...auditEvent(), hidden: false, visibilityState: 'visible' });
    }],
    ['untrusted row audit', (p, m) => { m.samples[0].visibilityAudit[0].isTrusted = false; }],
    ['inconsistent visible row', (p, m) => { m.samples[0].visibilityBefore.visibilityState = 'visible'; }],
    ['duplicate row clicks', (p, m) => { m.samples[0].clicks.push({ ...m.samples[0].clicks[0] }); }],
    ['missing reactive setter event', (p, m) => {
      m.samples[20].E0 = null;
      m.samples[20].latencyMs = 0;
    }],
    ['after observation visible', (p, m) => { m.afterHidden.cdp = { ...hidden(), hidden: false, visibilityState: 'visible' }; }],
    ['before native window visible', (p, m) => { m.beforeHidden.nativeBounds.windowState = 'normal'; }],
    ['native disagreement', (p, m) => { m.afterHidden.agree = false; }],
    ['failed restoration', (p, m) => { m.restoration.boundsMatch = false; }],
  ])('does not complete with $0', (name, corrupt) => {
    // Given
    const { probe, measurement } = completeInput();
    corrupt(probe, measurement);
    // When
    const report = finishHiddenReport(probe, measurement);
    // Then
    expect(report.status).toBe('BLOCKED_OR_PARTIAL');
  });
});

describe('hidden row validation and descriptive statistics', () => {
  it.each([undefined, '0', NaN, Infinity])('rejects invalid latency %s rather than completing', latencyMs => {
    // Given
    const { probe, measurement } = completeInput();
    measurement.samples[0].latencyMs = latencyMs;
    // When
    const parsed = hiddenRowSchema.safeParse(measurement.samples[0]);
    const report = finishHiddenReport(probe, measurement);
    // Then
    expect(parsed.success).toBe(false);
    expect(report.status).toBe('BLOCKED_OR_PARTIAL');
  });

  it('retains negative uncertainty, duplicate clicks and early-wall evidence without P99 or SLA', () => {
    // Given
    const { probe, measurement } = completeInput();
    const small = sample('small', 'scheduled', 12, -0.2);
    const early = sample('early', 'scheduled', 12, -2);
    early.success = false;
    early.clicks[0].wallMs = 9998;
    early.clicks.push({ jobId: 'early', epochMs: 10001, wallMs: 10001, trusted: false });
    measurement.samples = [small, sample('late', 'reactive', 1000, 8), early];
    // When
    const report = finishHiddenReport(probe, measurement);
    // Then
    expect(report.summary).toMatchObject({ count: 3, measured: 3, successes: 2, failures: 1,
      minMs: -2, maxMs: 8, medianMs: -0.2, dupCount: 1,
      negativeWithinUncertainty: 1, negativeBeyondUncertainty: 1, earlyWallGuardViolations: 1 });
    expect(report.summary.meanMs).toBeCloseTo(5.8 / 3);
    for (const stats of [report.summary, ...report.cells]) {
      expect(stats).not.toHaveProperty('p99Ms');
      expect(stats).not.toHaveProperty('sla');
      expect(stats).not.toHaveProperty('slaPassed');
    }
  });
});

describe('hiddenTrial measurement-only event fixture (not native visibility/runtime integration)', () => {
  it('subscribes before synchronous ARM, preserves the ledger, and removes listeners without retry', async () => {
    // Given
    const unit = measurementFixture({ audit: [auditEvent()], synchronous: true });
    const prior = unit.ledger[0];
    // When
    const row = await hiddenTrial(options());
    // Then
    expect(row).toMatchObject({ collectionReason: 'click', success: true,
      cancellation: 'acknowledged', E2: 10003, latencyMs: -12 });
    expect(row.clicks).toEqual([unit.ledger[1]]);
    expect(unit.ledger[0]).toBe(prior);
    expect(unit.runtime.install).toHaveBeenCalledTimes(1);
    expect(unit.runtime.arm).toHaveBeenCalledTimes(1);
    expect(unit.runtime.status).toHaveBeenCalledTimes(1);
    expect(unit.runtime.cancel).toHaveBeenCalledTimes(1);
    expect([...unit.listeners.values()].every(set => set.size === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('takes reactive E0 from the underlying disabled setter, not the intended timer deadline', async () => {
    // Given
    const unit = measurementFixture({ audit: [auditEvent()] });
    // When: hiddenTrial installs its event subscriptions before the timer is triggered.
    const outcome = hiddenTrial(options('reactive'));
    expect(unit.listeners.get('click').size).toBe(1);
    expect(unit.listeners.get('visibilitychange').size).toBe(1);
    await vi.advanceTimersToNextTimerAsync();
    await vi.advanceTimersToNextTimerAsync();
    const row = await outcome;
    // Then
    expect(row).toMatchObject({ success: true, collectionReason: 'click',
      E0: 11003, E1: 11005, E2: 11005, latencyMs: 2, actualStimulusLatenessMs: 3,
      intendedStimulusEpochMs: 11000, actualStimulus: { beforeEpochMs: 11000, epochMs: 11003 } });
    expect(unit.setterRecords).toEqual([{ value: false, epochMs: row.E0 }]);
    expect(Object.hasOwn(unit.button, 'disabled')).toBe(false);
    expect(unit.button.disabled).toBe(false);
    expect(row.clicks).toEqual(unit.ledger.filter(event => event.jobId === row.jobId));
    expect(unit.runtime.arm).toHaveBeenCalledTimes(1);
    expect(unit.runtime.cancel).toHaveBeenCalledTimes(1);
    expect([...unit.listeners.values()].every(set => set.size === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a reactive click without the enabling setter event rather than claiming success', async () => {
    // Given
    const unit = measurementFixture({ audit: [auditEvent()], synchronous: true });
    // When
    const row = await hiddenTrial(options('reactive'));
    // Then
    expect(row).toMatchObject({ success: false, E0: null, E1: null, latencyMs: null });
    expect(row.clicks).toEqual([unit.ledger[1]]);
    expect(unit.fixture.enable).not.toHaveBeenCalled();
    expect(unit.runtime.arm).toHaveBeenCalledTimes(1);
    expect(unit.runtime.cancel).toHaveBeenCalledTimes(1);
    expect(Object.hasOwn(unit.button, 'disabled')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['visible state', { visible: true, audit: [auditEvent()] }],
    ['empty audit', { audit: [] }],
    ['untrusted audit', { audit: [{ ...auditEvent(), isTrusted: false }] }],
    ['interrupted audit', { audit: [{ ...auditEvent(), hidden: false, visibilityState: 'visible' }, auditEvent()] }],
  ])('rejects %s before reset or installation', async (name, fixtureOptions) => {
    // Given
    const unit = measurementFixture(fixtureOptions);
    // When
    const row = await hiddenTrial(options());
    // Then
    expect(row).toMatchObject({ success: false, validVisibility: false,
      clicks: [], latencyMs: null, E0: null, E1: null, E2: null, cancellation: 'not-installed' });
    expect(unit.fixture.reset).not.toHaveBeenCalled();
    expect(unit.runtime.install).not.toHaveBeenCalled();
    expect(unit.runtime.arm).not.toHaveBeenCalled();
    expect(unit.runtime.cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends on visibility interruption and cancels the pending reactive stimulus', async () => {
    // Given
    const unit = measurementFixture({ audit: [auditEvent()] });
    // When
    const outcome = hiddenTrial(options('reactive'));
    unit.interrupt();
    const row = await outcome;
    // Then
    expect(row).toMatchObject({ collectionReason: 'visibility-lost', success: false,
      validVisibility: false, latencyMs: null, clicks: [], cancellation: 'acknowledged' });
    expect(unit.fixture.enable).not.toHaveBeenCalled();
    expect(unit.runtime.arm).toHaveBeenCalledTimes(1);
    expect(unit.runtime.cancel).toHaveBeenCalledTimes(1);
    expect([...unit.listeners.values()].every(set => set.size === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses only the audit segment subscribed for this trial', async () => {
    // Given
    const priorVisible = { ...auditEvent(), hidden: false, visibilityState: 'visible' };
    const unit = measurementFixture({ audit: [priorVisible, auditEvent()], synchronous: true });
    // When
    const row = await hiddenTrial({ ...options(), auditStartIndex: 1 });
    // Then
    expect(row).toMatchObject({ validVisibility: true, success: true });
    expect(row.visibilityAudit).toEqual([auditEvent()]);
    expect(unit.auditRecords).toEqual([priorVisible, auditEvent()]);
    expect(unit.ledger).toHaveLength(2);
  });

  it.each([
    ['unknown ARM', { terminal: true }, 'arm-terminal'],
    ['missing event', { missingClick: true }, 'collection-deadline'],
  ])('does not invent zero latency or retry after %s', async (name, fixtureOptions, collectionReason) => {
    // Given
    const unit = measurementFixture({ audit: [auditEvent()], ...fixtureOptions });
    // When
    const outcome = hiddenTrial(options());
    if (!fixtureOptions.terminal) await vi.advanceTimersToNextTimerAsync();
    const row = await outcome;
    // Then
    expect(row).toMatchObject({ collectionReason, success: false, latencyMs: null,
      E2: null, clicks: [], cancellation: 'acknowledged' });
    if (fixtureOptions.terminal) expect(row.status.state).toBe('UNKNOWN');
    expect(unit.runtime.install).toHaveBeenCalledTimes(1);
    expect(unit.runtime.arm).toHaveBeenCalledTimes(1);
    expect(unit.runtime.status).toHaveBeenCalledTimes(1);
    expect(unit.runtime.cancel).toHaveBeenCalledTimes(1);
    expect([...unit.listeners.values()].every(set => set.size === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not accept a verified click when cancellation fails', async () => {
    // Given
    const unit = measurementFixture({ audit: [auditEvent()], synchronous: true, cancelFails: true });
    // When
    const row = await hiddenTrial(options());
    // Then
    expect(row).toMatchObject({ success: false, cancellation: 'failed', clicks: [unit.ledger[1]] });
    expect(unit.runtime.cancel).toHaveBeenCalledTimes(1);
    expect([...unit.listeners.values()].every(set => set.size === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
