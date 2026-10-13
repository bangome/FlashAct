import { describe, expect, it } from 'vitest';
import { parseTime } from '../../src/cli/time.js';

describe('clock boundary', () => {
  it('resolves the next date when the local clock already passed', () => {
    // Given
    const now = Date.parse('2026-10-12T18:00:00Z');
    // When
    const time = parseTime('09:00:00.123', 'Asia/Seoul', now);
    // Then
    expect(time).toBe(Date.parse('2026-10-13T00:00:00.123Z'));
  });
  it('skips a nonexistent wall time when DST springs forward', () => {
    // Given
    const now = Date.parse('2026-03-08T05:00:00Z');
    // When
    const time = parseTime('02:30:00.000', 'America/New_York', now);
    // Then
    expect(time).toBe(Date.parse('2026-03-09T06:30:00Z'));
  });
  it('selects the second occurrence when the first DST fold already passed', () => {
    // Given
    const now = Date.parse('2026-11-01T05:45:00Z');
    // When
    const time = parseTime('01:30:00.000', 'America/New_York', now);
    // Then
    expect(time).toBe(Date.parse('2026-11-01T06:30:00Z'));
  });
  it('preserves the explicit offset when timezone differs', () => {
    // Given
    const now = Date.parse('2026-10-12T00:00:00Z');
    // When
    const time = parseTime('2026-10-13T09:00:00.123+09:00', 'America/New_York', now);
    // Then
    expect(time).toBe(Date.parse('2026-10-13T00:00:00.123Z'));
  });
  it.each(['2026-10-13T09:00:00', '25:00:00.000', '2026-02-30T12:00:00Z', '2026-10-13T24:00:00Z'])('rejects invalid or ambiguous input %s', input => {
    // Given
    const now = Date.parse('2026-01-01T00:00:00Z');
    // When / Then
    expect(() => parseTime(input, 'UTC', now)).toThrow();
  });
});
