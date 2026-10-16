import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompareInput, OpenResult } from '../../../../shared/ipc';
import type { NoteState, NotesFile } from '../../../../shared/notes';
import type { Analysis, CacheInfo, ReleaseSummary } from '../../../../shared/review';
import { api, errorMessage, run } from '../../lib/api';
import type { ComposerAt } from './model';

export type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; open: OpenResult };

/** What the page shows: a PR by URL / owner/repo#n, or a compare range. */
export type Source = { kind: 'pr'; input: string } | ({ kind: 'compare' } & CompareInput);

export interface Job {
  id: string | null;
  kind: 'review' | 'release';
  message: string;
}

export interface ReviewState {
  load: LoadState;
  analysis: Analysis | null;
  /** Where `analysis` came from: the on-disk cache or a run. */
  cache: CacheInfo | null;
  /** Compare ranges only. */
  release: ReleaseSummary | null;
  job: Job | null;
  jobError: { kind: Job['kind']; message: string } | null;
  notes: NotesFile;
  notice: string | null;
  clearNotice(): void;
  runReview(force: boolean): void;
  runRelease(force: boolean): void;
  cancelReview(): void;
  addNote(at: ComposerAt, path: string, body: string): Promise<boolean>;
  deleteNote(id: string): void;
  patchNote(id: string, patch: NoteState): void;
}

const EMPTY_NOTES: NotesFile = { mine: [], state: {} };

// The IPC schema is strict, so only the compare fields go over the wire.
const compareInput = ({ owner, repo, base, head, mode }: CompareInput): CompareInput => ({
  owner,
  repo,
  base,
  head,
  mode,
});

export function useReview(source: Source, autoRunMaxTokens: number): ReviewState {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [cache, setCache] = useState<CacheInfo | null>(null);
  const [release, setRelease] = useState<ReleaseSummary | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [jobError, setJobError] = useState<ReviewState['jobError']>(null);
  const [notes, setNotes] = useState<NotesFile>(EMPTY_NOTES);
  const [notice, setNotice] = useState<string | null>(null);
  const targetKey = load.status === 'ready' ? load.open.target.key : null;
  const subject = load.status === 'ready' ? load.open.target.subject : null;
  const jobRef = useRef<Job | null>(null);
  useEffect(() => {
    jobRef.current = job;
  }, [job]);

  const startJob = useCallback((key: string, force: boolean, kind: Job['kind']) => {
    setJobError(null);
    setJob({ id: null, kind, message: kind === 'review' ? 'Starting review…' : 'Starting…' });
    run(api.review.start({ targetKey: key, force, kind }))
      .then(({ jobId }) => setJob((j) => (j ? { ...j, id: jobId } : j)))
      .catch((e: unknown) => {
        setJob(null);
        setJobError({ kind, message: errorMessage(e) });
      });
  }, []);

  const runReview = useCallback(
    (force: boolean) => {
      if (targetKey) startJob(targetKey, force, 'review');
    },
    [targetKey, startJob],
  );
  const runRelease = useCallback(
    (force: boolean) => {
      if (targetKey) startJob(targetKey, force, 'release');
    },
    [targetKey, startJob],
  );

  // The page is keyed by its source, so this runs once with fresh state. Source and auto-run
  // budget are read once at mount: changing the budget in Settings must not reload the page.
  const [src] = useState(source);
  const [autoRunBudget] = useState(autoRunMaxTokens);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const open = await run(
          src.kind === 'pr'
            ? api.github.openPr({ input: src.input })
            : api.github.openCompare(compareInput(src)),
        );
        const file = await run(api.notes.list({ subject: open.target.subject }));
        if (!live) return;
        setNotes(file);
        setAnalysis(open.analysis);
        setCache(open.cache);
        setRelease(open.release);
        setLoad({ status: 'ready', open });
        if (
          !open.analysis &&
          !open.estimate.blocked &&
          autoRunBudget > 0 &&
          open.estimate.inputTokens <= autoRunBudget
        ) {
          startJob(open.target.key, false, 'review');
        }
      } catch (e) {
        if (live) setLoad({ status: 'error', message: errorMessage(e) });
      }
    })();
    return () => {
      live = false;
    };
  }, [src, autoRunBudget, startJob]);

  // Review events carry the target key, so they match even before `start` replies with a job ID.
  useEffect(() => {
    if (!targetKey) return;
    return api.review.onEvent((e) => {
      if (e.targetKey !== targetKey) return;
      const current = jobRef.current;
      if (current?.id && current.id !== e.jobId) return;
      if (e.type === 'started')
        setJob((j) => ({ id: e.jobId, kind: j?.kind ?? 'review', message: 'Queued…' }));
      else if (e.type === 'progress')
        setJob((j) => ({ id: e.jobId, kind: j?.kind ?? 'review', message: e.message }));
      else if (e.type === 'release') {
        setJob(null);
        setRelease(e.release);
      } else if (e.type === 'done') {
        setJob(null);
        setAnalysis(e.analysis);
        setCache(e.cache);
      } else {
        setJob(null);
        if (e.error.code !== 'CANCELLED') {
          setJobError({ kind: current?.kind ?? 'review', message: e.error.message });
        }
      }
    });
  }, [targetKey]);

  const cancelReview = useCallback(() => {
    const id = jobRef.current?.id;
    if (id)
      void run(api.review.cancel({ jobId: id })).catch((e: unknown) => setNotice(errorMessage(e)));
  }, []);

  const patchNote = useCallback(
    (id: string, patch: NoteState) => {
      if (!subject) return;
      setNotes((f) => ({ ...f, state: { ...f.state, [id]: { ...f.state[id], ...patch } } }));
      run(api.notes.patchState({ subject, id, patch })).catch((e: unknown) =>
        setNotice(`Could not save note state: ${errorMessage(e)}`),
      );
    },
    [subject],
  );

  const addNote = useCallback(
    async (at: ComposerAt, path: string, body: string): Promise<boolean> => {
      if (!subject) return false;
      try {
        const created = await run(
          api.notes.create({
            subject,
            path,
            side: at.side,
            line: at.line,
            lineId: at.lineId,
            body,
          }),
        );
        setNotes((f) => ({ ...f, mine: [...f.mine, created] }));
        return true;
      } catch (e) {
        setNotice(`Could not save the note: ${errorMessage(e)}`);
        return false;
      }
    },
    [subject],
  );

  const deleteNote = useCallback(
    (id: string) => {
      if (!subject) return;
      run(api.notes.delete({ subject, id }))
        .then(() => setNotes((f) => ({ ...f, mine: f.mine.filter((n) => n.id !== id) })))
        .catch((e: unknown) => setNotice(`Could not delete the note: ${errorMessage(e)}`));
    },
    [subject],
  );

  const clearNotice = useCallback(() => setNotice(null), []);

  return {
    load,
    analysis,
    cache,
    release,
    job,
    jobError,
    notes,
    notice,
    clearNotice,
    runReview,
    runRelease,
    cancelReview,
    addNote,
    deleteNote,
    patchNote,
  };
}
