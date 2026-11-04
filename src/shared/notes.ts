import { z } from 'zod';
import { Subject, TargetKey } from './subject';

/** GitHub's comment limit; also the most a note body can hold. */
export const MAX_COMMENT_BODY = 65_000;
/** Private notes that were never posted keep their original, smaller limit. */
export const MAX_PRIVATE_BODY = 10_000;

export const NoteState = z
  .object({
    seen: z.boolean().optional(),
    dismissed: z.boolean().optional(),
    collapsed: z.boolean().optional(),
    promoted: z.boolean().optional(),
  })
  .strict();
export type NoteState = z.infer<typeof NoteState>;

export const NoteId = z.string().regex(/^(ai|me)-[A-Za-z0-9_-]{4,64}$/);

export const PrivateNote = z
  .object({
    id: NoteId,
    source: z.literal('me'),
    path: z.string().min(1).max(1000),
    side: z.enum(['LEFT', 'RIGHT']),
    line: z.number().int().nonnegative(),
    lineId: z.string().regex(/^F[0-9]+-[0-9]{3,}$/),
    // Up to the comment limit so text posted to GitHub can be copied back into the note.
    body: z.string().min(1).max(MAX_COMMENT_BODY),
    createdAt: z.number().int(),
  })
  .strict();
export type PrivateNote = z.infer<typeof PrivateNote>;

/** The user's replacement body for an AI note; the cached analysis itself is never changed. */
export const NoteEdit = z.object({ body: z.string().min(1).max(MAX_COMMENT_BODY) }).strict();
export type NoteEdit = z.infer<typeof NoteEdit>;

/** A note's comment in the viewer's pending GitHub review and the text last posted there. */
export const PublishedLink = z
  .object({
    commentId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_+/=-]+$/),
    body: z.string().min(1).max(MAX_COMMENT_BODY),
  })
  .strict();
export type PublishedLink = z.infer<typeof PublishedLink>;

/**
 * Per-PR file on disk: private notes, seen/dismissed state of any note, edits of AI notes and
 * links to pending GitHub comments. Only main writes `published`. The newer fields default to
 * empty, so older files still load.
 */
export const NotesFile = z.object({
  mine: z.array(PrivateNote),
  state: z.record(NoteId, NoteState),
  edits: z.record(NoteId, NoteEdit).default({}),
  published: z.record(NoteId, PublishedLink).default({}),
});
export type NotesFile = z.infer<typeof NotesFile>;

export const CreateNoteInput = z
  .object({ subject: Subject })
  .extend(PrivateNote.omit({ id: true, source: true, createdAt: true }).shape)
  .extend({ body: z.string().min(1).max(MAX_PRIVATE_BODY) })
  .strict();

export const EditNoteInput = z
  .object({
    targetKey: TargetKey,
    id: NoteId,
    body: z.string().min(1).max(MAX_COMMENT_BODY),
  })
  .strict();

export const DeleteNoteInput = z.object({ subject: Subject, id: NoteId }).strict();

export const PatchNoteStateInput = z
  .object({ subject: Subject, id: NoteId, patch: NoteState })
  .strict();
