import { z } from 'zod';
import { jobStatusSchema } from '../dist/core/schema.js';
import { summarizeVisible } from './visible-latency-page.mjs';

export const hiddenMatrix = Object.freeze([
  { scenario: 'scheduled', horizonMs: 12, trials: 20 },
  { scenario: 'reactive', horizonMs: 1000, trials: 20 },
].map(Object.freeze));

const visibilitySchema = z.object({ epochMs: z.number(), wallMs: z.number(),
  hidden: z.boolean(), visibilityState: z.enum(['visible', 'hidden']) });
export const hiddenRowSchema = z.object({
  jobId: z.string(), scenario: z.enum(['scheduled', 'reactive']), horizonMs: z.number(),
  validVisibility: z.boolean(), success: z.boolean(), latencyMs: z.number().nullable(),
  visibilityBefore: visibilitySchema, visibilityAfter: visibilitySchema,
  visibilityAudit: z.array(visibilitySchema.extend({
    kind: z.enum(['initial', 'visibilitychange']), isTrusted: z.boolean().nullable(),
  })),
  clicks: z.array(z.object({ jobId: z.string(), epochMs: z.number(), wallMs: z.number(), trusted: z.boolean() })),
  cancellation: z.enum(['not-installed', 'acknowledged', 'failed']),
  status: jobStatusSchema.optional(), armReceipt: jobStatusSchema.optional(), cancelReceipt: jobStatusSchema.optional(),
  E0: z.number().nullable(), E1: z.number().nullable(), E2: z.number().nullable(),
  targetEpochMs: z.number(), targetWallEpochMs: z.number(), targetUncertaintyMs: z.number(),
}).passthrough();

export function finishHiddenReport(probe, measurement) {
  const samples = measurement.samples;
  const observed = samples.map(row => {
    const visibility = row.validVisibility && row.visibilityBefore.hidden === true
      && row.visibilityBefore.visibilityState === 'hidden' && row.visibilityAfter.hidden === true
      && row.visibilityAfter.visibilityState === 'hidden' && row.visibilityAudit?.length > 0
      && row.visibilityAudit.every(event => event.kind === 'visibilitychange' && event.isTrusted === true
        && event.hidden === true && event.visibilityState === 'hidden');
    const timing = Number.isFinite(row.latencyMs) && Number.isFinite(row.E2)
      && (row.scenario === 'scheduled' || Number.isFinite(row.E0));
    return { ...row, validVisibility: visibility, latencyMs: timing ? row.latencyMs : null,
      success: row.success && visibility && timing && row.status?.state === 'VERIFIED'
        && row.status.executions === 1 && row.clicks.length === 1
        && row.clicks[0].trusted === false && row.cancellation === 'acknowledged' };
  });
  // Only reuse descriptive arithmetic; the visible trial's policy is not reused.
  const summary = summarizeVisible(observed);
  const plannedTrials = hiddenMatrix.reduce((total, cell) => total + cell.trials, 0);
  const nativeHidden = observation => observation?.agree === true && observation.cdp.hidden
    && observation.cdp.visibilityState === 'hidden' && observation.nativeBounds.windowState === 'minimized';
  const coverage = nativeHidden(measurement.beforeHidden) && nativeHidden(measurement.afterHidden)
    && measurement.visibilityAudit?.length > 0 && measurement.visibilityAudit.every(event =>
      event.kind === 'visibilitychange' && event.isTrusted === true && event.hidden && event.visibilityState === 'hidden')
    && measurement.restoration?.status === 'restored' && measurement.restoration.boundsMatch === true;
  const cells = hiddenMatrix.map(cell => ({ ...cell,
    ...summarizeVisible(observed.filter(row => row.scenario === cell.scenario && row.horizonMs === cell.horizonMs)) }));
  const complete = probe.status === 'HIDDEN_GATE_VERIFIED' && probe.nativeGate.passed
    && probe.provenance.passed && probe.provenance.targetWindowBound
    && probe.cleanupSuccess && probe.hashManifest?.unchanged && !probe.lifecycle.stopReason
    && probe.errors.length === 0 && coverage && measurement.activeTrial === null
    && measurement.attemptedTrials === plannedTrials && cells.every(cell => cell.count === cell.trials)
    && summary.successes === plannedTrials && summary.measured === plannedTrials
    && new Set(samples.map(row => row.jobId)).size === plannedTrials
    && measurement.finalLedger?.length === plannedTrials && samples.every(row =>
      row.cancellation === 'acknowledged' && row.visibilityBefore.hidden && row.visibilityAfter.hidden
      && row.status?.state === 'VERIFIED' && row.status.executions === 1 && row.armReceipt
      && row.cancelReceipt?.executions === 1 && row.clicks[0]?.trusted === false
      && measurement.finalLedger.filter(event => event.jobId === row.jobId).length === 1);
  return { status: complete ? 'HIDDEN_MEASURED' : 'BLOCKED_OR_PARTIAL', scope: 'IMMEDIATE NATIVE HIDDEN ONLY',
    command: 'node scripts/hidden-latency-benchmark.mjs', probePath: probe.reportPath,
    nativeGate: probe.nativeGate, cleanupSuccess: probe.cleanupSuccess, preservation: probe.hashManifest?.unchanged,
    ownership: { childPid: probe.child?.pid, profile: probe.profile?.path },
    teardown: probe.teardown, driverExit: probe.driverExit, pending: probe.lifecycle.pending,
    plannedTrials, attemptedTrials: measurement.attemptedTrials, completedTrials: samples.length,
    hiddenTrials: samples.filter(row => row.armReceipt && row.validVisibility).length,
    activeTrial: measurement.activeTrial, matrix: hiddenMatrix, samples, cells, summary, coverage,
    beforeHidden: measurement.beforeHidden, afterHidden: measurement.afterHidden,
    visibilityAudit: measurement.visibilityAudit, restoration: measurement.restoration,
    finalLedger: measurement.finalLedger, errors: probe.errors, stopReason: probe.lifecycle.stopReason,
    runtimeSha256: probe.runtimeSha256, startedAt: probe.startedAt, finishedAt: probe.finishedAt,
    limitations: ['Small serial cells; no population P99 or SLA.',
      'Immediate minimized-window evidence, not hidden aging, background-tab policy, sleep/wake or saturation.',
      'Untrusted local synthetic clicks; no trusted input, network or site-acceptance evidence.',
      'E0 follows the real disabled setter; E1 is runtime timing, not independent mutation-only attribution.',
      'A missing driver reply retains UNKNOWN in-flight outcome; no retries or post-stop salvage.'] };
}
