import { FlashActError } from '../utils/errors.js';

export function parseTime(input: string, timezone = 'UTC', now = Date.now()): number {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input)) {
    const epoch = Date.parse(input);
    const date = input.slice(0, 10);
    const normalized = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(epoch) || !Number.isFinite(normalized.getTime()) || normalized.toISOString().slice(0, 10) !== date ||
        Number(input.slice(11, 13)) > 23 || Number(input.slice(14, 16)) > 59 || Number(input.slice(17, 19)) > 59 || epoch <= now)
      throw new FlashActError('INVALID_PLAN', 'Time must be a valid future instant');
    return epoch;
  }
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?$/.exec(input);
  if (!match) throw new FlashActError('INVALID_PLAN', 'Use HH:mm:ss.SSS or ISO with an explicit offset');
  const hour = Number(match[1]); const minute = Number(match[2]); const second = Number(match[3]);
  const millisecond = Number(match[4] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) throw new FlashActError('INVALID_PLAN', 'Invalid clock time');
  const fields = (epoch: number) => {
    const parts = formatter.formatToParts(epoch);
    const part = (name: string) => Number(parts.find(item => item.type === name)?.value);
    return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute'), second: part('second') };
  };
  const today = fields(now);
  for (let day = 0; day < 370; day++) {
    const nominal = Date.UTC(today.year, today.month - 1, today.day + day, hour, minute, second, millisecond);
    const candidates = new Set<number>();
    // Enumerate offsets on both sides of a DST transition, then round-trip wall time.
    for (let delta = -36; delta <= 36; delta += 3) {
      const sample = nominal + delta * 3_600_000;
      const local = fields(sample);
      const offset = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - Math.floor(sample / 1000) * 1000;
      const candidate = nominal - offset;
      const actual = fields(candidate);
      if (Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second, millisecond) === nominal && candidate > now)
        candidates.add(candidate);
    }
    if (candidates.size) return Math.min(...candidates);
  }
  throw new FlashActError('INVALID_PLAN', 'No future wall-clock occurrence found');
}
