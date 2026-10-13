import { describe, expect, it } from 'vitest';
import { summarizeVisible } from '../../scripts/visible-latency-page.mjs';

const sample = latencyMs => ({ scenario: 'scheduled', validVisibility: true, success: true,
  latencyMs, targetWallEpochMs: 100, targetUncertaintyMs: 1,
  clicks: [{ epochMs: 100 + latencyMs, wallMs: 100 + Math.max(0, latencyMs), trusted: false }] });

describe('small-cell visible latency statistics', () => {
  it.each([
    { delays: [7, 1, 3], mean: 11 / 3, median: 3 },
    { delays: [8, 2, 4, 6], mean: 5, median: 5 },
  ])('computes descriptive mean and median from unordered $delays', ({ delays, mean, median }) => {
    // Given
    const rows = delays.map(sample);
    // When
    const result = summarizeVisible(rows);
    // Then
    expect(result).toMatchObject({ count: delays.length, measured: delays.length, meanMs: mean, medianMs: median });
  });

  it('counts a missing event as a failure without inventing zero latency', () => {
    // Given
    const rows = [sample(4), { ...sample(null), success: false, clicks: [] }];
    // When
    const result = summarizeVisible(rows);
    // Then
    expect(result).toMatchObject({ count: 2, successes: 1, failures: 1, measured: 1, meanMs: 4 });
  });

  it('retains small negative clock deltas without calling them wall-clock violations', () => {
    // Given
    const rows = [sample(-0.2)];
    // When
    const result = summarizeVisible(rows);
    // Then
    expect(result).toMatchObject({ negativeWithinUncertainty: 1, negativeBeyondUncertainty: 0,
      earlyWallGuardViolations: 0, minMs: -0.2 });
  });

  it('counts duplicate clicks and genuine early guard violations', () => {
    // Given
    const rows = [{ ...sample(-2), success: false,
      clicks: [{ epochMs: 98, wallMs: 98 }, { epochMs: 101, wallMs: 101 }] }];
    // When
    const result = summarizeVisible(rows);
    // Then
    expect(result).toMatchObject({ failures: 1, dupCount: 1, earlyWallGuardViolations: 1, negativeBeyondUncertainty: 1 });
  });

  it('does not include a hidden-invalidated trial in visible latency statistics', () => {
    // Given
    const rows = [{ ...sample(999), validVisibility: false, success: false }, sample(2)];
    // When
    const result = summarizeVisible(rows);
    // Then
    expect(result).toMatchObject({ failures: 1, measured: 1, meanMs: 2, maxMs: 2 });
  });
});
