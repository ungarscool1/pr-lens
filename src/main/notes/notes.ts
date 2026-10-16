import { randomBytes } from 'node:crypto';
import { NotesFile } from '../../shared/notes';
import type { NoteState, PrivateNote } from '../../shared/notes';
import { subjectSlug } from '../../shared/subject';
import type { Subject } from '../../shared/subject';
import type { JsonStore } from '../store/json-store';

export interface NotesService {
  list(subject: Subject): Promise<NotesFile>;
  create(
    subject: Subject,
    note: Omit<PrivateNote, 'id' | 'source' | 'createdAt'>,
  ): Promise<PrivateNote>;
  delete(subject: Subject, id: string): Promise<void>;
  patchState(subject: Subject, id: string, patch: NoteState): Promise<void>;
}

const EMPTY: NotesFile = { mine: [], state: {} };

// A PR is keyed by number, not head SHA, so private notes and state survive new pushes;
// a compare range by its SHAs.
const fileFor = (s: Subject): string => `notes/${subjectSlug(s)}.json`;

export function createNotes(store: JsonStore): NotesService {
  const load = (subject: Subject): Promise<NotesFile> =>
    store.read(fileFor(subject), NotesFile, EMPTY);
  // Read-modify-write is serialized per PR so two quick clicks cannot lose an update.
  const locks = new Map<string, Promise<unknown>>();
  const mutate = <T>(
    subject: Subject,
    fn: (f: NotesFile) => { next: NotesFile; result: T },
  ): Promise<T> => {
    const key = fileFor(subject);
    const run = (locks.get(key) ?? Promise.resolve()).then(async () => {
      const { next, result } = fn(await load(subject));
      await store.write(key, next);
      return result;
    });
    locks.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  };

  return {
    list: load,
    create: (subject, note) =>
      mutate(subject, (f) => {
        const created: PrivateNote = {
          ...note,
          id: `me-${randomBytes(9).toString('base64url')}`,
          source: 'me',
          createdAt: Date.now(),
        };
        return { next: { ...f, mine: [...f.mine, created] }, result: created };
      }),
    delete: (subject, id) =>
      mutate(subject, (f) => {
        const state = Object.fromEntries(Object.entries(f.state).filter(([k]) => k !== id));
        return { next: { mine: f.mine.filter((n) => n.id !== id), state }, result: undefined };
      }),
    patchState: (subject, id, patch) =>
      mutate(subject, (f) => ({
        next: { ...f, state: { ...f.state, [id]: { ...f.state[id], ...patch } } },
        result: undefined,
      })),
  };
}
