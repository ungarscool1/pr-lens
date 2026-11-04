import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors';
import type { EditNoteResult, PromotePreview } from '../../shared/ipc';
import { MAX_COMMENT_BODY, MAX_PRIVATE_BODY } from '../../shared/notes';
import type { PrRef } from '../../shared/pr';
import type { NotesService } from '../notes/notes';
import { resolveNote } from '../notes/resolve';
import type { ResolvedNote } from '../notes/resolve';
import type { AnalysisCache } from '../review/cache';
import type { LoadedTarget, ReviewService } from '../review/service';
import type { SettingsService } from '../settings/settings';
import type { CommentInfo, GitHubWriteClient, ThreadInput } from './write-client';

export interface PromoteService {
  /** What would be posted, plus a single-use token that `confirm` requires. Writes nothing. */
  preview(targetKey: string, noteId: string): Promise<PromotePreview>;
  /** Adds the comment to the viewer's pending review (creating one if needed). */
  confirm(confirmToken: string, body: string): Promise<{ url: string | null }>;
  /** Submits the pending GitHub review; local/private notes are never sent. */
  submitReview(
    targetKey: string,
    event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES',
    body: string,
  ): Promise<{ url: string | null; state: string }>;
  /**
   * Edits a private or AI note. A note linked to the viewer's pending GitHub comment updates that
   * comment too, after checking with GitHub that it is still pending, theirs and on this PR;
   * otherwise only the local text changes.
   */
  editNote(targetKey: string, noteId: string, body: string): Promise<EditNoteResult>;
}

interface Deps {
  write: GitHubWriteClient;
  review: Pick<ReviewService, 'loaded'>;
  cache: AnalysisCache;
  notes: NotesService;
  settings: SettingsService;
  now?: () => number;
}

export const CONFIRM_TTL_MS = 2 * 60_000;
export const MAX_BODY = MAX_COMMENT_BODY;

/**
 * The comment as first shown in the dialog; the user edits it before confirming. For an AI
 * note, `n.body` is already the user's edited body when there is one (see `resolveNote`).
 */
export function defaultBody(n: ResolvedNote): string {
  if (n.source === 'me') return n.body;
  return [`**${n.title}**`, '', n.body, ...(n.question ? ['', n.question] : [])].join('\n');
}

export function threadFor(n: ResolvedNote, body: string): ThreadInput {
  if (n.fileLevel) return { kind: 'file', path: n.path, body };
  return {
    kind: 'line',
    path: n.path,
    side: n.side,
    line: n.endLine,
    ...(n.startLine < n.endLine ? { startLine: n.startLine } : {}),
    body,
  };
}

export function createPromote(d: Deps): PromoteService {
  const now = d.now ?? Date.now;
  const tokens = new Map<string, { targetKey: string; noteId: string; expires: number }>();

  const requireEnabled = (): void => {
    if (!d.settings.current().promoteEnabled) {
      throw new AppError('BAD_INPUT', 'Promote to comment is off. Turn it on in Settings first.');
    }
  };
  const requirePr = (key: string): { loaded: LoadedTarget; ref: PrRef } => {
    const loaded = d.review.loaded(key);
    if (!loaded) throw new AppError('BAD_INPUT', 'Open the pull request again first.');
    const s = loaded.target.subject;
    if (s.kind !== 'pr')
      throw new AppError('BAD_INPUT', 'Only notes on a pull request can become review comments.');
    return { loaded, ref: s.ref };
  };
  const note = (loaded: LoadedTarget, noteId: string): Promise<ResolvedNote> =>
    resolveNote(
      { cache: d.cache, notes: d.notes, settings: () => d.settings.current() },
      loaded,
      noteId,
    );

  return {
    async preview(key, noteId) {
      requireEnabled();
      const { loaded, ref } = requirePr(key);
      const n = await note(loaded, noteId);
      const ctx = await d.write.reviewContext(ref);
      if (ctx.headSha !== loaded.target.headSha) {
        throw new AppError(
          'BAD_INPUT',
          'The PR has new commits since this review. Open it again (and re-run) before promoting.',
        );
      }
      for (const [t, v] of tokens) if (v.expires < now()) tokens.delete(t);
      const confirmToken = randomUUID();
      tokens.set(confirmToken, { targetKey: key, noteId, expires: now() + CONFIRM_TTL_MS });
      return {
        confirmToken,
        pr: `${ref.owner}/${ref.repo}#${ref.number}`,
        headSha: ctx.headSha,
        viewer: ctx.viewer,
        path: n.path,
        side: n.side,
        startLine: n.startLine,
        endLine: n.endLine,
        fileLevel: n.fileLevel,
        pendingReviewExists: ctx.pendingReviewId !== null,
        body: defaultBody(n),
      };
    },

    async confirm(confirmToken, body) {
      requireEnabled();
      const entry = tokens.get(confirmToken);
      tokens.delete(confirmToken); // single use, whatever happens next
      if (!entry || entry.expires < now()) {
        throw new AppError('BAD_INPUT', 'This confirmation expired. Open the dialog again.');
      }
      const text = body.trim();
      if (!text || text.length > MAX_BODY)
        throw new AppError('BAD_INPUT', 'The comment must be 1 to 65,000 characters.');

      const { loaded, ref } = requirePr(entry.targetKey);
      const n = await note(loaded, entry.noteId);
      // Checked again: the head may have moved while the dialog was open.
      const ctx = await d.write.reviewContext(ref);
      if (ctx.headSha !== loaded.target.headSha) {
        throw new AppError(
          'BAD_INPUT',
          'The PR has new commits since this review. Nothing was posted.',
        );
      }
      const reviewId =
        ctx.pendingReviewId ?? (await d.write.createPendingReview(ctx.prId, ctx.headSha));
      const { url, commentId } = await d.write.addThread(reviewId, threadFor(n, text));
      const s = loaded.target.subject;
      await d.notes.patchState(s, n.id, { promoted: true });
      if (commentId) await d.notes.setPublished(s, n.id, { commentId, body: text });
      // The note keeps what was posted, including any changes made in the dialog.
      if (n.source === 'me') await d.notes.updateBody(s, n.id, text);
      return { url };
    },

    async submitReview(key, event, body) {
      requireEnabled();
      const text = body.trim();
      if (text.length > MAX_BODY)
        throw new AppError('BAD_INPUT', 'The review comment must be at most 65,000 characters.');
      if ((event === 'COMMENT' || event === 'REQUEST_CHANGES') && !text) {
        throw new AppError('BAD_INPUT', 'Add a comment before submitting this review.');
      }
      const { loaded, ref } = requirePr(key);
      // Re-read immediately before mutation so staged comments cannot be submitted on a stale head.
      const ctx = await d.write.reviewContext(ref);
      if (ctx.headSha !== loaded.target.headSha) {
        throw new AppError(
          'BAD_INPUT',
          'The PR has new commits since this review. Nothing was submitted.',
        );
      }
      const reviewId =
        ctx.pendingReviewId ?? (await d.write.createPendingReview(ctx.prId, ctx.headSha));
      const result = await d.write.submitReview(reviewId, event, text);
      // Submitted comments are public now and must never be edited from here.
      await d.notes.clearPublished(loaded.target.subject);
      return result;
    },

    async editNote(key, noteId, body) {
      const text = body.trim();
      if (!text || text.length > MAX_BODY)
        throw new AppError('BAD_INPUT', 'The note must be 1 to 65,000 characters.');
      const loaded = d.review.loaded(key);
      if (!loaded) throw new AppError('BAD_INPUT', 'Open the pull request again first.');
      const s = loaded.target.subject;
      const n = await note(loaded, noteId);

      const saveLocal = async (): Promise<void> => {
        if (n.source === 'me') await d.notes.updateBody(s, n.id, text);
        else await d.notes.setEdit(s, n.id, text);
      };
      const done = async (
        synced: EditNoteResult['synced'],
        reason?: string,
      ): Promise<EditNoteResult> => ({
        notes: await d.notes.list(s),
        synced,
        ...(reason ? { reason } : {}),
      });

      const link = n.published;
      if (!link) {
        if (n.source === 'me' && text.length > MAX_PRIVATE_BODY)
          throw new AppError('BAD_INPUT', 'A private note must be 1 to 10,000 characters.');
        await saveLocal();
        return done('local');
      }

      requireEnabled();
      const { ref } = requirePr(key);
      // Only NOT_FOUND means "this comment is gone"; any other failure (auth, network) is
      // thrown before anything is saved, so the note and the comment never drift apart silently.
      const goneOr = (err: unknown): string => {
        if (AppError.from(err).code === 'NOT_FOUND')
          return 'The comment is no longer on GitHub, so the edit was saved locally only.';
        throw err;
      };
      let reason: string | null;
      try {
        reason = refusal(await d.write.pendingComment(link.commentId), ref);
      } catch (err) {
        reason = goneOr(err);
      }
      if (reason === null) {
        try {
          await d.write.updateComment(link.commentId, text);
        } catch (err) {
          reason = goneOr(err);
        }
      }
      if (reason === null) {
        await d.notes.setPublished(s, n.id, { commentId: link.commentId, body: text });
        if (n.source === 'me') await d.notes.updateBody(s, n.id, text);
        return done('github');
      }
      await d.notes.setPublished(s, n.id, null);
      await d.notes.patchState(s, n.id, { promoted: false });
      await saveLocal();
      return done('local', reason);
    },
  };
}

/** Why a linked comment must not be edited, or null when it is the viewer's pending one on `ref`. */
export function refusal(c: CommentInfo | null, ref: PrRef): string | null {
  if (!c) return 'The comment is no longer on GitHub, so the edit was saved locally only.';
  if (c.state !== 'PENDING')
    return 'The review with this comment was already submitted, so the edit was saved locally only.';
  if (c.author !== c.viewer || !c.viewerCanUpdate)
    return 'That GitHub comment is not one you can edit, so the edit was saved locally only.';
  const same =
    c.owner.toLowerCase() === ref.owner.toLowerCase() &&
    c.repo.toLowerCase() === ref.repo.toLowerCase() &&
    c.number === ref.number;
  if (!same)
    return 'That GitHub comment is on another pull request, so the edit was saved locally only.';
  return null;
}
