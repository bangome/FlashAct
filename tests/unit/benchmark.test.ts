import { describe, expect, it } from 'vitest';
import { baselineReceiptSchema, sampleSchema, summarize } from '../../src/benchmark/statistics.js';

describe('benchmark statistics', () => {
  it('retains browser receipt timing when a baseline sample is parsed', () => {
    // Given
    const receipt = baselineReceiptSchema.parse({receivedEpochMs: 102, clicks: [{epochMs: 103, wallMs: 103, trusted: false}]});
    // When
    const sample = sampleSchema.parse({jobId: 'baseline', scenario: 'node-scheduled', targetEpochMs: 100, schedulerEpochMs: 101, ...receipt});
    // Then
    expect(sample.receivedEpochMs).toBe(102);
  });
  it('rejects a host response when browser receipt timing is absent', () => {
    // Given
    const payload = {clicks: [{epochMs: 103, wallMs: 103, trusted: false}]};
    // When
    const result = baselineReceiptSchema.safeParse(payload);
    // Then
    expect(result.success).toBe(false);
  });
  it('uses nearest-rank percentiles when observations arrive out of order', () => {
    // Given
    const samples = [9, 1, 5, 3, 7].map((delay, index) => ({jobId: String(index), scenario: 'scheduled',
      targetEpochMs: 100, clicks: [{epochMs: 100 + delay, wallMs: 100 + delay, trusted: false}]}));
    // When
    const stats = summarize(samples);
    // Then
    expect(stats).toMatchObject({count: 5, measured: 5, meanMs: 5, p50Ms: 5, p95Ms: 9, p99Ms: 9, maxMs: 9, successRate: 1});
  });
  it('excludes missing events from latency when a dispatch fails', () => {
    // Given
    const samples = [{jobId: 'missing', scenario: 'reactive', targetEpochMs: 100, clicks: []},
      {jobId: 'clicked', scenario: 'reactive', targetEpochMs: 100, clicks: [{epochMs: 104, wallMs: 104, trusted: false}]}];
    // When
    const stats = summarize(samples);
    // Then
    expect(stats).toMatchObject({count: 2, measured: 1, failures: 1, meanMs: 4, successRate: 0.5});
  });
  it('counts duplicate and early clicks when a single-shot contract is violated', () => {
    // Given
    const samples = [{jobId: 'duplicate', scenario: 'scheduled', targetEpochMs: 100, wallTargetEpochMs: 100,
      clicks: [{epochMs: 99.75, wallMs: 100, trusted: false}, {epochMs: 102, wallMs: 102, trusted: false}]}];
    // When
    const stats = summarize(samples);
    // Then
    expect(stats).toMatchObject({duplicates: 1, early: 1, wallClockEarly: 0, failures: 1, successRate: 0, meanMs: -0.25});
  });
  it('reports unavailable percentiles when no event is observed', () => {
    // Given
    const samples: [] = [];
    // When
    const stats = summarize(samples);
    // Then
    expect(stats).toMatchObject({count: 0, measured: 0, meanMs: null, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null});
  });
});
