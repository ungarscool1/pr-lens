import type { AiNote, Category, DroppedNote, Severity } from '../../shared/review';
import type { ValidNote } from './validate';

const SEVERITY_WEIGHT: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
const CATEGORY_WEIGHT: Partial<Record<Category, number>> = {
  security: 1.2,
  api_break: 1.2,
  data_migration: 1.2,
  missing_tests: 0.8,
};
const LOW_CONFIDENCE_FLOOR = 0.4;

export const scoreNote = (n: Pick<ValidNote, 'severity' | 'confidence' | 'category'>): number =>
  Math.round(
    SEVERITY_WEIGHT[n.severity] * n.confidence * (CATEGORY_WEIGHT[n.category] ?? 1) * 100,
  ) / 100;

/**
 * Scores, de-duplicates by identity, drops weak low-severity notes and caps the list.
 * A high note is never cut to make room for a lower one.
 */
export function rankNotes(
  notes: readonly ValidNote[],
  maxNotes: number,
): { kept: AiNote[]; cut: DroppedNote[] } {
  const cut: DroppedNote[] = [];
  const byId = new Map<string, AiNote>();
  for (const n of notes) {
    const scored = { ...n, score: scoreNote(n) };
    if (n.severity === 'low' && n.confidence < LOW_CONFIDENCE_FLOOR) {
      cut.push({ key: n.id, title: n.title, reason: 'low severity and low confidence' });
      continue;
    }
    const prev = byId.get(n.id);
    if (prev) cut.push({ key: n.id, title: n.title, reason: 'duplicate' });
    if (!prev || prev.score < scored.score) byId.set(n.id, scored);
  }

  const ordered = [...byId.values()].sort((a, b) => b.score - a.score);
  const highs = ordered.filter((n) => n.severity === 'high');
  const keep = new Set(
    [...highs, ...ordered.filter((n) => n.severity !== 'high')].slice(
      0,
      Math.max(maxNotes, highs.length),
    ),
  );
  for (const n of ordered)
    if (!keep.has(n)) cut.push({ key: n.id, title: n.title, reason: 'over the note cap' });
  return { kept: ordered.filter((n) => keep.has(n)), cut };
}
