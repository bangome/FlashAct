import { z } from 'zod';
import { jobStatusSchema } from '../core/schema.js';

export const sampleSchema = z.object({
  jobId: z.string(), scenario: z.string(), targetEpochMs: z.number(),
  clicks: z.array(z.object({epochMs: z.number(), wallMs: z.number(), trusted: z.boolean()})),
  status: jobStatusSchema.optional(), schedulerEpochMs: z.number().optional(), receivedEpochMs: z.number().optional(),
  wallTargetEpochMs: z.number().optional(), hostTargetEpochMs: z.number().optional(), hostDispatchEpochMs: z.number().optional(),
  targetUncertaintyMs: z.number().optional(),
});
export type BenchmarkSample = z.infer<typeof sampleSchema>;

export const baselineReceiptSchema = z.object({receivedEpochMs: z.number(), clicks: sampleSchema.shape.clicks});

/** Nearest-rank percentiles; failures never become zero-latency samples. */
export function summarize(samples: readonly BenchmarkSample[]) {
  const delays = samples.flatMap(sample => {
    const click = sample.clicks[0];
    return click ? [click.epochMs - sample.targetEpochMs] : [];
  }).sort((a, b) => a - b);
  const percentile = (fraction: number): number | null =>
    delays[Math.max(0, Math.ceil(delays.length * fraction) - 1)] ?? null;
  const failures = samples.filter(sample => sample.clicks.length !== 1 ||
    (sample.status !== undefined && sample.status.state !== 'VERIFIED')).length;
  return {
    count: samples.length, measured: delays.length, failures,
    duplicates: samples.reduce((total, sample) => total + Math.max(0, sample.clicks.length - 1), 0),
    early: delays.filter(delay => delay < 0).length,
    earlyBeyondUncertainty: samples.filter(sample => (sample.clicks[0]?.epochMs ?? Infinity) - sample.targetEpochMs < -(sample.targetUncertaintyMs ?? 0)).length,
    wallClockEarly: samples.filter(sample => sample.wallTargetEpochMs !== undefined && sample.clicks.some(click => click.wallMs < (sample.wallTargetEpochMs ?? 0))).length,
    hostGuardEarly: samples.filter(sample => sample.hostTargetEpochMs !== undefined && sample.hostDispatchEpochMs !== undefined && sample.hostDispatchEpochMs < sample.hostTargetEpochMs).length,
    successRate: samples.length ? (samples.length - failures) / samples.length : 0,
    meanMs: delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: delays.at(-1) ?? null,
  };
}
