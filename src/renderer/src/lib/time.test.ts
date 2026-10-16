import { describe, expect, it } from 'vitest';
import { ago } from './time';

describe('ago', () => {
  const now = 1_700_000_000_000;
  it.each([
    [now - 10_000, 'just now'],
    [now - 5 * 60_000, '5 minutes ago'],
    [now - 2 * 3_600_000, '2 hours ago'],
    [now - 86_400_000, 'yesterday'],
    [now - 14 * 86_400_000, '2 weeks ago'],
  ])('%s → %s', (ts, label) => expect(ago(ts, now)).toBe(label));
});
