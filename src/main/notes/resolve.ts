import { AppError } from '../../shared/errors';
import type { Side } from '../../shared/diff';
import type { PublishedLink } from '../../shared/notes';
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
  /** For AI notes, the user's edited body when there is one. */
  body: string;
  /** The AI note's body was replaced by the user. */
  edited?: true;
  /** The note's comment in the viewer's pending GitHub review, if it was linked. */
  published?: PublishedLink;
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
  const file = await d.notes.list(subject);
  const published = file.published[noteId];
  const link = published ? { published } : {};
  if (noteId.startsWith('ai-')) {
    const hit = await d.cache.get(subject, headSha, d.settings());
    const n = hit?.analysis.notes.find((x) => x.id === noteId);
    if (!n) throw new AppError('NOT_FOUND', 'That note is no longer in the review.');
    const edit = file.edits[noteId];
    return {
      id: n.id,
      source: 'ai',
      label: `[${n.severity} · ${CATEGORY_LABELS[n.category].toLowerCase()}]`,
      title: n.title,
      body: edit?.body ?? n.body,
      ...(edit ? { edited: true as const } : {}),
      ...link,
      ...(n.question ? { question: n.question } : {}),
      path: n.path,
      side: n.side,
      startLine: n.startLine,
      endLine: n.endLine,
      fileLevel: n.fileLevel,
    };
  }
  const mine = file.mine.find((x) => x.id === noteId);
  if (!mine) throw new AppError('NOT_FOUND', 'That note was deleted.');
  return {
    id: mine.id,
    source: 'me',
    label: '[private]',
    title: mine.body.split('\n')[0]?.slice(0, 120) ?? '',
    body: mine.body,
    ...link,
    path: mine.path,
    side: mine.side,
    startLine: mine.line,
    endLine: mine.line,
    fileLevel: false,
  };
}
