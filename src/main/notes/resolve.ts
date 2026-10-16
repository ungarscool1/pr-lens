import { AppError } from '../../shared/errors';
import type { Side } from '../../shared/diff';
import { CATEGORY_LABELS } from '../../shared/review';
import type { Settings } from '../../shared/settings';
import type { AnalysisCache } from '../review/cache';
import type { LoadedTarget } from '../review/service';
import type { NotesService } from './notes';

/** A note of an open target, AI or private, in one shape for features that act on it. */
export interface ResolvedNote {
  id: string;
  source: 'ai' | 'me';
  /** `[high · security]` or `[private]`. */
  label: string;
  /** AI title, or the first line of a private note. */
  title: string;
  body: string;
  question?: string;
  path: string;
  side: Side;
  /** 0 for file-level notes. */
  startLine: number;
  endLine: number;
  fileLevel: boolean;
}

/** Looks a note up where it lives: the cached analysis (AI) or the notes file (private). */
export async function resolveNote(
  d: { cache: AnalysisCache; notes: NotesService; settings: () => Settings },
  loaded: LoadedTarget,
  noteId: string,
): Promise<ResolvedNote> {
  const { subject, headSha } = loaded.target;
  if (noteId.startsWith('ai-')) {
    const hit = await d.cache.get(subject, headSha, d.settings());
    const n = hit?.analysis.notes.find((x) => x.id === noteId);
    if (!n) throw new AppError('NOT_FOUND', 'That note is no longer in the review.');
    return {
      id: n.id,
      source: 'ai',
      label: `[${n.severity} · ${CATEGORY_LABELS[n.category].toLowerCase()}]`,
      title: n.title,
      body: n.body,
      ...(n.question ? { question: n.question } : {}),
      path: n.path,
      side: n.side,
      startLine: n.startLine,
      endLine: n.endLine,
      fileLevel: n.fileLevel,
    };
  }
  const mine = (await d.notes.list(subject)).mine.find((x) => x.id === noteId);
  if (!mine) throw new AppError('NOT_FOUND', 'That note was deleted.');
  return {
    id: mine.id,
    source: 'me',
    label: '[private]',
    title: mine.body.split('\n')[0]?.slice(0, 120) ?? '',
    body: mine.body,
    path: mine.path,
    side: mine.side,
    startLine: mine.line,
    endLine: mine.line,
    fileLevel: false,
  };
}
