import type { DiffFile, DiffHunk } from '../../../../shared/diff';

/** Lines one click reveals, as on GitHub. */
export const EXPAND_STEP = 20;

export type ExpandDir = 'down' | 'up' | 'all';

/**
 * Unchanged lines revealed in one gap: `down` continues below the hunk above the gap, `up`
 * continues above the hunk below it. Either may exceed the gap; readers clamp.
 */
export interface Reveal {
  down: number;
  up: number;
}
export type Reveals = Readonly<Record<number, Reveal>>;

/**
 * The unchanged lines around the hunks: gap `i` sits before hunk `i`, and one more after the
 * last hunk. Line numbers are new-side; old = new + delta, since nothing in a gap changed.
 */
export interface Gap {
  index: number;
  from: number;
  /** Inclusive. Null after the last hunk until the file's length is known. */
  to: number | null;
  delta: number;
}

const HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Where a hunk sits on each side: its first line and the line after it. */
function span(h: DiffHunk) {
  const olds = h.lines.filter((l) => l.old !== undefined).length;
  const news = h.lines.filter((l) => l.new !== undefined).length;
  const m = HEADER.exec(h.header);
  // A side with no lines (`+4,0`) names the line before the hunk.
  const oldBegin = m
    ? Number(m[1]) + (olds ? 0 : 1)
    : (h.lines.find((l) => l.old !== undefined)?.old ?? 1);
  const newBegin = m
    ? Number(m[2]) + (news ? 0 : 1)
    : (h.lines.find((l) => l.new !== undefined)?.new ?? 1);
  return { oldBegin, newBegin, oldEnd: oldBegin + olds, newEnd: newBegin + news };
}

export function gapsOf(file: DiffFile, lineCount: number | null): Gap[] {
  const spans = file.hunks.map(span);
  return Array.from({ length: spans.length + 1 }, (_, index): Gap => {
    const prev = spans[index - 1];
    const next = spans[index];
    return {
      index,
      from: prev ? prev.newEnd : 1,
      to: next ? next.newBegin - 1 : lineCount,
      delta: prev ? prev.oldEnd - prev.newEnd : next ? next.oldBegin - next.newBegin : 0,
    };
  });
}

export const gapSize = (g: Gap): number | null =>
  g.to === null ? null : Math.max(0, g.to - g.from + 1);

/** The revealed line ranges of a gap (inclusive, empty when to < from) and what stays hidden. */
export function shownIn(
  g: Gap,
  r: Reveal | undefined,
): { down: [number, number]; up: [number, number]; hidden: number | null } {
  const size = gapSize(g);
  if (size === null) return { down: [g.from, g.from - 1], up: [0, -1], hidden: null };
  const down = Math.min(r?.down ?? 0, size);
  const up = Math.min(r?.up ?? 0, size - down);
  const to = g.to as number;
  return {
    down: [g.from, g.from + down - 1],
    up: [to - up + 1, to],
    hidden: size - down - up,
  };
}

export function expandReveal(r: Reveal | undefined, dir: ExpandDir): Reveal {
  const cur = r ?? { down: 0, up: 0 };
  if (dir === 'all') return { down: Infinity, up: 0 };
  return dir === 'down'
    ? { ...cur, down: cur.down + EXPAND_STEP }
    : { ...cur, up: cur.up + EXPAND_STEP };
}

/**
 * The buttons a gap offers: one "show all" once the rest fits in a step, otherwise a step from
 * each hunk that borders it. Before the first hunk only up, after the last only down.
 */
export function gapActions(g: Gap, last: boolean, hidden: number | null): ExpandDir[] {
  if (hidden !== null && hidden <= EXPAND_STEP) return hidden > 0 ? ['all'] : [];
  if (g.index === 0) return ['up'];
  if (last) return ['down'];
  return ['down', 'up'];
}

/** Grows the reveals so new-side lines `from`…`to` show, by the shorter way into each gap they cross. */
export function revealRange(
  gaps: readonly Gap[],
  reveals: Reveals,
  from: number,
  to: number,
): Reveals {
  const next: Record<number, Reveal> = { ...reveals };
  for (const g of gaps) {
    const a = Math.max(from, g.from);
    const b = Math.min(to, g.to ?? Infinity);
    if (a > b) continue;
    const r = next[g.index] ?? { down: 0, up: 0 };
    const needDown = b - g.from + 1;
    const needUp = g.to === null ? Infinity : g.to - a + 1;
    if (r.down >= needDown || r.up >= needUp) continue;
    next[g.index] = needDown <= needUp ? { ...r, down: needDown } : { ...r, up: needUp };
  }
  return next;
}
