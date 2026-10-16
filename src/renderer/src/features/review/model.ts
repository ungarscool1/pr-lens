import type { DiffFile, DiffLine, Side } from '../../../../shared/diff';
import type { NoteState, PrivateNote } from '../../../../shared/notes';
import type { AiNote } from '../../../../shared/review';
import { changedRanges, markRange, tokenize } from '../../lib/highlight';
import type { Tok } from '../../lib/highlight';

/** AI and private notes in one shape, so the diff and sidebar treat them alike. */
export type ViewNote =
  | (AiNote & { lineId: string })
  | {
      id: string;
      source: 'me';
      fid: string;
      path: string;
      side: Side;
      startLine: number;
      endLine: number;
      lineId: string;
      body: string;
    };

export type Filter = 'all' | 'high' | 'mine';
export type ViewMode = 'unified' | 'split';

export function toViewNotes(ai: readonly AiNote[], mine: readonly PrivateNote[]): ViewNote[] {
  const aiSorted = [...ai]
    .sort((a, b) => b.score - a.score)
    .map((n) => ({ ...n, lineId: n.startLineId }));
  const me = mine.map((n): ViewNote => ({
    id: n.id,
    source: 'me',
    fid: n.lineId.split('-')[0] ?? '',
    path: n.path,
    side: n.side,
    startLine: n.line,
    endLine: n.line,
    lineId: n.lineId,
    body: n.body,
  }));
  return [...aiSorted, ...me];
}

const isFileLevel = (n: ViewNote): boolean => n.source === 'ai' && n.fileLevel;

export const passesFilter = (n: ViewNote, f: Filter): boolean =>
  f === 'all' || (f === 'high' ? n.source === 'ai' && n.severity === 'high' : n.source === 'me');

/** The j/k order: ranked AI notes, then mine, skipping dismissed and filtered-out notes. */
export function navigableNotes(
  notes: readonly ViewNote[],
  state: Readonly<Record<string, NoteState>>,
  filter: Filter,
): ViewNote[] {
  return notes.filter((n) => passesFilter(n, filter) && !state[n.id]?.dismissed);
}

export function stepNote(
  list: readonly ViewNote[],
  currentId: string | null,
  dir: 1 | -1,
): ViewNote | null {
  if (!list.length) return null;
  const i = list.findIndex((n) => n.id === currentId);
  const next = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
  return list[next] ?? null;
}

export interface Cell {
  line: DiffLine;
  side: Side;
  num: number;
  toks: Tok[];
}

export type Row =
  | { kind: 'hunk'; key: string; header: string }
  | { kind: 'line'; key: string; cell: Cell }
  | { kind: 'pair'; key: string; left: Cell | null; right: Cell | null }
  | { kind: 'note'; key: string; note: ViewNote }
  | { kind: 'composer'; key: string };

export interface ComposerAt {
  fid: string;
  side: Side;
  line: number;
  lineId: string;
}

const cellOf = (line: DiffLine, toks: Tok[]): Cell => {
  const side: Side = line.kind === 'del' ? 'LEFT' : 'RIGHT';
  return { line, side, num: (side === 'LEFT' ? line.old : line.new) ?? 0, toks };
};

/** Highlights each line, then marks the changed span of paired removed/added lines. */
export function highlightHunk(lines: readonly DiffLine[]): Map<string, Tok[]> {
  const toks = new Map(lines.map((l) => [l.id, tokenize(l.text)]));
  forEachChangeBlock(lines, (dels, adds) => {
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const d = dels[k];
      const a = adds[k];
      if (!d || !a) continue;
      const r = changedRanges(d.text, a.text);
      if (!r) continue;
      toks.set(d.id, markRange(toks.get(d.id) ?? [], r.del));
      toks.set(a.id, markRange(toks.get(a.id) ?? [], r.add));
    }
  });
  return toks;
}

function forEachChangeBlock(
  lines: readonly DiffLine[],
  fn: (dels: DiffLine[], adds: DiffLine[]) => void,
): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i]?.kind === 'ctx') {
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (lines[i]?.kind === 'del') dels.push(lines[i++] as DiffLine);
    while (lines[i]?.kind === 'add') adds.push(lines[i++] as DiffLine);
    fn(dels, adds);
  }
}

/**
 * Flattens a file into render rows: hunk headers, lines (or side-by-side pairs), and notes
 * and the composer right after the line they end on.
 */
export function buildRows(
  file: DiffFile,
  notes: readonly ViewNote[],
  mode: ViewMode,
  composer: ComposerAt | null,
): Row[] {
  const rows: Row[] = [];
  const after = (side: Side, num: number): void => {
    for (const n of notes) {
      if (!isFileLevel(n) && n.side === side && n.endLine === num)
        rows.push({ kind: 'note', key: `note-${n.id}`, note: n });
    }
    if (composer && composer.fid === file.fid && composer.side === side && composer.line === num) {
      rows.push({ kind: 'composer', key: 'composer' });
    }
  };

  // File-level notes (no line could be anchored) sit above the first hunk.
  for (const n of notes)
    if (isFileLevel(n)) rows.push({ kind: 'note', key: `note-${n.id}`, note: n });

  file.hunks.forEach((h, hi) => {
    rows.push({ kind: 'hunk', key: `h${hi}`, header: h.header });
    const toks = highlightHunk(h.lines);
    const cell = (l: DiffLine): Cell => cellOf(l, toks.get(l.id) ?? []);

    if (mode === 'unified') {
      for (const l of h.lines) {
        const c = cell(l);
        rows.push({ kind: 'line', key: l.id, cell: c });
        after(c.side, c.num);
      }
      return;
    }
    let pi = 0;
    const pair = (left: Cell | null, right: Cell | null): void => {
      rows.push({ kind: 'pair', key: `p${hi}-${pi++}`, left, right });
      if (left && left.line.kind === 'del') after('LEFT', left.num);
      if (right) after('RIGHT', right.num);
    };
    let i = 0;
    while (i < h.lines.length) {
      const l = h.lines[i] as DiffLine;
      if (l.kind === 'ctx') {
        pair({ ...cell(l), side: 'LEFT', num: l.old ?? 0 }, cell(l));
        i++;
        continue;
      }
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (h.lines[i]?.kind === 'del') dels.push(h.lines[i++] as DiffLine);
      while (h.lines[i]?.kind === 'add') adds.push(h.lines[i++] as DiffLine);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const d = dels[k];
        const a = adds[k];
        pair(d ? cell(d) : null, a ? cell(a) : null);
      }
    }
  });
  return rows;
}

/** Line numbers covered by open (not collapsed, not dismissed) notes, per side. */
export function highlightedLines(
  notes: readonly ViewNote[],
  state: Readonly<Record<string, NoteState>>,
): Record<Side, Set<number>> {
  const hl: Record<Side, Set<number>> = { LEFT: new Set(), RIGHT: new Set() };
  for (const n of notes) {
    const st = state[n.id];
    if (st?.dismissed || st?.collapsed || isFileLevel(n)) continue;
    for (let i = n.startLine; i <= n.endLine; i++) hl[n.side].add(i);
  }
  return hl;
}
