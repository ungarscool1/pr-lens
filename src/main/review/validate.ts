import { createHash } from 'node:crypto';
import type { DiffLine, DiffModel } from '../../shared/diff';
import type { AiNote, DroppedNote, FileRisk, ModelOutput } from '../../shared/review';

export type ValidNote = Omit<AiNote, 'score'>;

export interface Validated {
  notes: ValidNote[];
  dropped: DroppedNote[];
  files: FileRisk[];
  readingOrder: string[];
}

/** `f2-03 ` → `F2-003`. Returns the input unchanged if it is not shaped like a line ID. */
export function normalizeLineId(id: string): string {
  const m = /^\s*f(\d+)-(\d+)\s*$/i.exec(id);
  return m ? `F${Number(m[1])}-${String(Number(m[2])).padStart(3, '0')}` : id.trim();
}

const normalizeFileId = (id: string): string => {
  const m = /^\s*f(\d+)\s*$/i.exec(id);
  return m ? `F${Number(m[1])}` : id.trim();
};

interface Located {
  fid: string;
  path: string;
  index: number;
  lines: DiffLine[];
}

function indexLines(diff: DiffModel): Map<string, Located> {
  const map = new Map<string, Located>();
  for (const f of diff.files) {
    const lines = f.hunks.flatMap((h) => h.lines);
    lines.forEach((l, index) => map.set(l.id, { fid: f.fid, path: f.path, index, lines }));
  }
  return map;
}

/**
 * Checks every note's anchors against the diff and resolves line IDs to path/side/line
 * numbers. Notes whose start line does not exist are dropped with a reason.
 */
export function validateModelOutput(out: ModelOutput, diff: DiffModel): Validated {
  const lines = indexLines(diff);
  const notes: ValidNote[] = [];
  const dropped: DroppedNote[] = [];

  for (const n of out.notes) {
    let start = normalizeLineId(n.anchor.start);
    let end = normalizeLineId(n.anchor.end);
    let repaired = start !== n.anchor.start || end !== n.anchor.end;

    const s = lines.get(start);
    if (!s) {
      dropped.push({ key: n.key, title: n.title, reason: `unknown line ${n.anchor.start}` });
      continue;
    }
    let e = lines.get(end);
    if (!e || e.fid !== s.fid) {
      end = start;
      e = s;
      repaired = true;
    }
    let [a, b] = [s.index, e.index];
    if (b < a) {
      [a, b] = [b, a];
      [start, end] = [end, start];
      repaired = true;
    }

    const span = s.lines.slice(a, b + 1);
    const leftOnly = span.every((l) => l.kind === 'del');
    const nums = span
      .map((l) => (leftOnly ? l.old : l.kind === 'del' ? undefined : l.new))
      .filter((x): x is number => x !== undefined);

    notes.push({
      id: noteIdentity(s.path, n.category, s.lines[a]?.text ?? ''),
      source: 'ai',
      fid: s.fid,
      path: s.path,
      side: leftOnly ? 'LEFT' : 'RIGHT',
      startLineId: start,
      endLineId: end,
      startLine: Math.min(...nums),
      endLine: Math.max(...nums),
      severity: n.severity,
      category: n.category,
      title: n.title,
      body: n.explanation,
      ...(n.question ? { question: n.question } : {}),
      refs: (n.refs ?? []).map(normalizeLineId),
      confidence: n.confidence,
      repaired,
    });
  }

  const known = new Set(diff.files.map((f) => f.fid));
  const files = out.files
    .map((f) => ({ fid: normalizeFileId(f.file), risk: f.risk, why: f.why }))
    .filter((f) => known.has(f.fid));
  const listed = [...new Set(out.reading_order.map(normalizeFileId))].filter((id) => known.has(id));
  const reviewed = diff.files.filter((f) => f.noise === null).map((f) => f.fid);
  const readingOrder = [...listed, ...reviewed.filter((id) => !listed.includes(id))];

  return { notes, dropped, files, readingOrder };
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
