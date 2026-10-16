const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "just now", "5 minutes ago", "yesterday"… */
export function ago(ts: number, now: number = Date.now()): string {
  const s = Math.round((ts - now) / 1000);
  if (Math.abs(s) < 45) return 'just now';
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86_400],
    ['week', 604_800],
  ];
  let unit: Intl.RelativeTimeFormatUnit = 'minute';
  let size = 60;
  for (const [u, n] of steps) if (Math.abs(s) >= n) [unit, size] = [u, n];
  return rtf.format(Math.round(s / size), unit);
}
