import { createHash } from 'node:crypto';
import type { DiffLine, DiffModel } from '../../shared/diff';
import type { AiNote, DroppedNote, FileRisk, ModelNote, ModelOutput } from '../../shared/review';

export type ValidNote = Omit<AiNote, 'score'>;

export interface Validated {
  notes: ValidNote[];
  dropped: DroppedNote[];
  files: FileRisk[];
  readingOrder: string[];
}

/** What one prompt showed the model: only these IDs are valid anchors for its answer. */
export interface Visible {
  fids: ReadonlySet<string>;
  lineIds: ReadonlySet<string>;
}

export const MAX_SPAN_LINES = 20;
const QUOTE_MISS_PENALTY = 0.2;

/** `f2-03 ` → `F2-003`. Returns the input trimmed if it is not shaped like a line ID. */
export function normalizeLineId(id: string): string {
  const m = /^\s*f(\d+)-(\d+)\s*$/i.exec(id);
  return m ? `F${Number(m[1])}-${String(Number(m[2])).padStart(3, '0')}` : id.trim();
}

export function normalizeFileId(id: string): string {
  const m = /^\s*f(\d+)\s*$/i.exec(id);
  return m ? `F${Number(m[1])}` : id.trim();
}

/** Everything in the diff is visible: the single-chunk case. */
export function visibleAll(diff: DiffModel): Visible {
  const lineIds = new Set<string>();
  const fids = new Set<string>();
  for (const f of diff.files) {
    if (f.noise !== null) continue;
    fids.add(f.fid);
    for (const h of f.hunks) for (const l of h.lines) lineIds.add(l.id);
  }
  return { fids, lineIds };
}

interface FileLines {
  fid: string;
  path: string;
  lines: DiffLine[];
  index: Map<string, number>;
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
const hasQuote = (line: DiffLine | undefined, quote: string): boolean =>
  !!line && squash(line.text).includes(squash(quote));

/**
 * Checks one chunk's notes against what that chunk showed, repairs what can be repaired
 * and resolves line IDs to path / side / line numbers. Repairs, in order:
 * padding of IDs; an unknown start found again by its quote (anchor file first, then every
 * visible file); an unknown or cross-file end collapsed to the start; reversed spans; spans
 * over 20 lines truncated; a start line that does not hold the quote moved to the line in the
 * span that does (or confidence lowered). A note whose lines cannot be found but whose file
 * was shown becomes a file-level note; anything else is dropped with a reason.
 */
export function validateNotes(
  notes: readonly ModelNote[],
  diff: DiffModel,
  visible: Visible,
): { notes: ValidNote[]; dropped: DroppedNote[] } {
  const files = new Map<string, FileLines>();
  const byLine = new Map<string, FileLines>();
  for (const f of diff.files) {
    if (!visible.fids.has(f.fid)) continue;
    const lines = f.hunks.flatMap((h) => h.lines).filter((l) => visible.lineIds.has(l.id));
    const entry = {
      fid: f.fid,
      path: f.path,
      lines,
      index: new Map(lines.map((l, i) => [l.id, i])),
    };
    files.set(f.fid, entry);
    for (const l of lines) byLine.set(l.id, entry);
  }

  const out: ValidNote[] = [];
  const dropped: DroppedNote[] = [];

  for (const n of notes) {
    const anchorFid = normalizeFileId(n.anchor.file);
    let start = normalizeLineId(n.anchor.start);
    let end = normalizeLineId(n.anchor.end);
    let repaired = start !== n.anchor.start || end !== n.anchor.end;
    let confidence = n.confidence;

    let file = byLine.get(start);
    if (!file) {
      const found = findQuote(n.quote, files, anchorFid);
      if (found) {
        file = found.file;
        start = end = found.lineId;
        repaired = true;
      }
    }
    if (!file) {
      const known = files.get(anchorFid);
      if (known) {
        out.push(fileLevelNote(n, known, confidence));
        continue;
      }
      dropped.push({
        key: n.key,
        title: n.title,
        reason: `unknown line ${n.anchor.start}, quote not found`,
      });
      continue;
    }

    let a = file.index.get(start) ?? 0;
    let b = file.index.get(end);
    if (b === undefined) {
      b = a;
      repaired = true;
    }
    if (b < a) {
      [a, b] = [b, a];
      repaired = true;
    }
    if (b - a + 1 > MAX_SPAN_LINES) {
      b = a + MAX_SPAN_LINES - 1;
      repaired = true;
    }
    if (!hasQuote(file.lines[a], n.quote)) {
      const at = file.lines.slice(a, b + 1).findIndex((l) => hasQuote(l, n.quote));
      if (at > 0) {
        a += at;
        repaired = true;
      } else {
        confidence = Math.max(0, Math.round((confidence - QUOTE_MISS_PENALTY) * 100) / 100);
      }
    }

    const span = file.lines.slice(a, b + 1);
    const leftOnly = span.every((l) => l.kind === 'del');
    const nums = span
      .map((l) => (leftOnly ? l.old : l.kind === 'del' ? undefined : l.new))
      .filter((x): x is number => x !== undefined);

    out.push({
      ...common(n, file, confidence),
      id: noteIdentity(file.path, n.category, file.lines[a]?.text ?? ''),
      side: leftOnly ? 'LEFT' : 'RIGHT',
      startLineId: file.lines[a]?.id ?? start,
      endLineId: file.lines[b]?.id ?? end,
      startLine: Math.min(...nums),
      endLine: Math.max(...nums),
      fileLevel: false,
      repaired,
    });
  }
  return { notes: out, dropped };
}

function findQuote(
  quote: string,
  files: ReadonlyMap<string, FileLines>,
  preferFid: string,
): { file: FileLines; lineId: string } | null {
  const search = (fs: FileLines[]): { file: FileLines; lineId: string }[] =>
    fs.flatMap((file) =>
      file.lines.filter((l) => hasQuote(l, quote)).map((l) => ({ file, lineId: l.id })),
    );
  const preferred = files.get(preferFid);
  const inAnchor = preferred ? search([preferred]) : [];
  if (inAnchor.length === 1) return inAnchor[0] ?? null;
  if (inAnchor.length > 1) return null; // ambiguous: guessing would anchor to the wrong line
  const everywhere = search([...files.values()]);
  return everywhere.length === 1 ? (everywhere[0] ?? null) : null;
}

function common(n: ModelNote, file: FileLines, confidence: number) {
  return {
    source: 'ai' as const,
    fid: file.fid,
    path: file.path,
    severity: n.severity,
    category: n.category,
    title: n.title,
    body: n.explanation,
    ...(n.question ? { question: n.question } : {}),
    refs: (n.refs ?? []).map((r) => normalizeLineId(normalizeFileId(r))),
    confidence,
  };
}

function fileLevelNote(n: ModelNote, file: FileLines, confidence: number): ValidNote {
  return {
    ...common(n, file, confidence),
    id: noteIdentity(file.path, n.category, `file:${n.title}`),
    side: 'RIGHT',
    startLineId: '',
    endLineId: '',
    startLine: 0,
    endLine: 0,
    fileLevel: true,
    repaired: true,
  };
}

/** Files and reading order from one model answer, restricted to the files it was shown. */
export function validateFiles(
  out: Pick<ModelOutput, 'files' | 'reading_order'>,
  visible: Visible,
): Pick<Validated, 'files' | 'readingOrder'> {
  const files = out.files
    .map((f) => ({ fid: normalizeFileId(f.file), risk: f.risk, why: f.why }))
    .filter((f) => visible.fids.has(f.fid));
  const readingOrder = [...new Set(out.reading_order.map(normalizeFileId))].filter((id) =>
    visible.fids.has(id),
  );
  return { files, readingOrder };
}

/** Appends files the model left out, so every reviewed file has a place in the order. */
export function completeReadingOrder(order: readonly string[], diff: DiffModel): string[] {
  const listed = [...new Set(order)];
  const rest = diff.files
    .filter((f) => f.noise === null && !listed.includes(f.fid))
    .map((f) => f.fid);
  return [...listed, ...rest];
}

/** The single-chunk path: one answer, everything visible. */
export function validateModelOutput(out: ModelOutput, diff: DiffModel): Validated {
  const visible = visibleAll(diff);
  const { notes, dropped } = validateNotes(out.notes, diff, visible);
  const { files, readingOrder } = validateFiles(out, visible);
  return { notes, dropped, files, readingOrder: completeReadingOrder(readingOrder, diff) };
}

/**
 * Stable across re-runs of the same PR so seen/dismissed state carries over, as long as the
 * note lands on the same code with the same category.
 */
export function noteIdentity(path: string, category: string, anchorText: string): string {
  const h = createHash('sha1')
    .update(`${path}\0${category}\0${anchorText.trim()}`)
    .digest('base64url');
  return `ai-${h.slice(0, 16)}`;
}
