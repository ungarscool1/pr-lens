import { z } from 'zod';
import { PrRef } from './pr';

export const NoteState = z
  .object({
    seen: z.boolean().optional(),
    dismissed: z.boolean().optional(),
    collapsed: z.boolean().optional(),
    promoted: z.boolean().optional(),
  })
  .strict();
export type NoteState = z.infer<typeof NoteState>;

const NOTE_ID = z.string().regex(/^(ai|me)-[A-Za-z0-9_-]{4,64}$/);

export const PrivateNote = z
  .object({
    id: NOTE_ID,
    source: z.literal('me'),
    path: z.string().min(1).max(1000),
    side: z.enum(['LEFT', 'RIGHT']),
    line: z.number().int().nonnegative(),
    lineId: z.string().regex(/^F[0-9]+-[0-9]{3,}$/),
    body: z.string().min(1).max(10_000),
    createdAt: z.number().int(),
  })
  .strict();
export type PrivateNote = z.infer<typeof PrivateNote>;

/** Per-PR file on disk: private notes plus seen/dismissed state of any note. */
export const NotesFile = z.object({
  mine: z.array(PrivateNote),
  state: z.record(NOTE_ID, NoteState),
});
export type NotesFile = z.infer<typeof NotesFile>;

export const CreateNoteInput = z
  .object({ ref: PrRef })
  .extend(PrivateNote.omit({ id: true, source: true, createdAt: true }).shape)
  .strict();

export const DeleteNoteInput = z.object({ ref: PrRef, id: NOTE_ID }).strict();

export const PatchNoteStateInput = z.object({ ref: PrRef, id: NOTE_ID, patch: NoteState }).strict();
