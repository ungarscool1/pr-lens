import { randomBytes } from 'node:crypto';
import { NotesFile } from '../../shared/notes';
import type { NoteState, PrivateNote } from '../../shared/notes';
import type { PrRef } from '../../shared/pr';
import type { JsonStore } from '../store/json-store';

export interface NotesService {
  list(ref: PrRef): Promise<NotesFile>;
  create(ref: PrRef, note: Omit<PrivateNote, 'id' | 'source' | 'createdAt'>): Promise<PrivateNote>;
  delete(ref: PrRef, id: string): Promise<void>;
  patchState(ref: PrRef, id: string, patch: NoteState): Promise<void>;
}

const EMPTY: NotesFile = { mine: [], state: {} };

// Keyed by PR, not head SHA, so private notes and seen/dismissed state survive new pushes.
const fileFor = (r: PrRef): string => `notes/${r.owner}__${r.repo}__${r.number}.json`;

export function createNotes(store: JsonStore): NotesService {
  const load = (ref: PrRef): Promise<NotesFile> => store.read(fileFor(ref), NotesFile, EMPTY);
  // Read-modify-write is serialized per PR so two quick clicks cannot lose an update.
  const locks = new Map<string, Promise<unknown>>();
  const mutate = <T>(
    ref: PrRef,
    fn: (f: NotesFile) => { next: NotesFile; result: T },
  ): Promise<T> => {
    const key = fileFor(ref);
    const run = (locks.get(key) ?? Promise.resolve()).then(async () => {
      const { next, result } = fn(await load(ref));
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
    create: (ref, note) =>
      mutate(ref, (f) => {
        const created: PrivateNote = {
          ...note,
          id: `me-${randomBytes(9).toString('base64url')}`,
          source: 'me',
          createdAt: Date.now(),
        };
        return { next: { ...f, mine: [...f.mine, created] }, result: created };
      }),
    delete: (ref, id) =>
      mutate(ref, (f) => {
        const state = Object.fromEntries(Object.entries(f.state).filter(([k]) => k !== id));
        return { next: { mine: f.mine.filter((n) => n.id !== id), state }, result: undefined };
      }),
    patchState: (ref, id, patch) =>
      mutate(ref, (f) => ({
        next: { ...f, state: { ...f.state, [id]: { ...f.state[id], ...patch } } },
        result: undefined,
      })),
  };
}
