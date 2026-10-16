import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpenPrResult } from '../../../../shared/ipc';
import type { NoteState, NotesFile } from '../../../../shared/notes';
import type { Analysis, CacheInfo } from '../../../../shared/review';
import { api, errorMessage, run } from '../../lib/api';
import type { ComposerAt } from './model';

export type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; pr: OpenPrResult };

export interface Job {
  id: string | null;
  message: string;
}

export interface ReviewState {
  load: LoadState;
  analysis: Analysis | null;
  /** Where `analysis` came from: the on-disk cache or a run. */
  cache: CacheInfo | null;
  job: Job | null;
  jobError: string | null;
  notes: NotesFile;
  notice: string | null;
  clearNotice(): void;
  runReview(force: boolean): void;
  cancelReview(): void;
  addNote(at: ComposerAt, path: string, body: string): Promise<boolean>;
  deleteNote(id: string): void;
  patchNote(id: string, patch: NoteState): void;
}

const EMPTY_NOTES: NotesFile = { mine: [], state: {} };

export function useReview(input: string, autoRunMaxTokens: number): ReviewState {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [cache, setCache] = useState<CacheInfo | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [notes, setNotes] = useState<NotesFile>(EMPTY_NOTES);
  const [notice, setNotice] = useState<string | null>(null);
  const targetKey = load.status === 'ready' ? load.pr.target.key : null;
  const ref = load.status === 'ready' ? load.pr.target.ref : null;
  const jobRef = useRef<Job | null>(null);
  useEffect(() => {
    jobRef.current = job;
  }, [job]);

  const startJob = useCallback((key: string, force: boolean) => {
    setJobError(null);
    setJob({ id: null, message: 'Starting review…' });
    run(api.review.start({ targetKey: key, force }))
      .then(({ jobId }) => setJob((j) => (j ? { ...j, id: jobId } : j)))
      .catch((e: unknown) => {
        setJob(null);
        setJobError(errorMessage(e));
      });
  }, []);

  const runReview = useCallback(
    (force: boolean) => {
      if (targetKey) startJob(targetKey, force);
    },
    [targetKey, startJob],
  );

  // The page is keyed by input, so this runs once per PR with fresh state. The auto-run
  // budget is read once at mount: changing it in Settings must not reload the PR.
  const [autoRunBudget] = useState(autoRunMaxTokens);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const pr = await run(api.github.openPr({ input }));
        const file = await run(api.notes.list({ ref: pr.target.ref }));
        if (!live) return;
        setNotes(file);
        setAnalysis(pr.analysis);
        setCache(pr.cache);
        setLoad({ status: 'ready', pr });
        if (
          !pr.analysis &&
          !pr.estimate.blocked &&
          autoRunBudget > 0 &&
          pr.estimate.inputTokens <= autoRunBudget
        ) {
          startJob(pr.target.key, false);
        }
      } catch (e) {
        if (live) setLoad({ status: 'error', message: errorMessage(e) });
      }
    })();
    return () => {
      live = false;
    };
  }, [input, autoRunBudget, startJob]);

  // Review events carry the target key, so they match even before `start` replies with a job ID.
  useEffect(() => {
    if (!targetKey) return;
    return api.review.onEvent((e) => {
      if (e.targetKey !== targetKey) return;
      const current = jobRef.current;
      if (current?.id && current.id !== e.jobId) return;
      if (e.type === 'started') setJob({ id: e.jobId, message: 'Queued…' });
      else if (e.type === 'progress') setJob({ id: e.jobId, message: e.message });
      else if (e.type === 'done') {
        setJob(null);
        setAnalysis(e.analysis);
        setCache(e.cache);
      } else {
        setJob(null);
        if (e.error.code !== 'CANCELLED') setJobError(e.error.message);
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
      if (!ref) return;
      setNotes((f) => ({ ...f, state: { ...f.state, [id]: { ...f.state[id], ...patch } } }));
      run(api.notes.patchState({ ref, id, patch })).catch((e: unknown) =>
        setNotice(`Could not save note state: ${errorMessage(e)}`),
      );
    },
    [ref],
  );

  const addNote = useCallback(
    async (at: ComposerAt, path: string, body: string): Promise<boolean> => {
      if (!ref) return false;
      try {
        const created = await run(
          api.notes.create({ ref, path, side: at.side, line: at.line, lineId: at.lineId, body }),
        );
        setNotes((f) => ({ ...f, mine: [...f.mine, created] }));
        return true;
      } catch (e) {
        setNotice(`Could not save the note: ${errorMessage(e)}`);
        return false;
      }
    },
    [ref],
  );

  const deleteNote = useCallback(
    (id: string) => {
      if (!ref) return;
      run(api.notes.delete({ ref, id }))
        .then(() => setNotes((f) => ({ ...f, mine: f.mine.filter((n) => n.id !== id) })))
        .catch((e: unknown) => setNotice(`Could not delete the note: ${errorMessage(e)}`));
    },
    [ref],
  );

  const clearNotice = useCallback(() => setNotice(null), []);

  return {
    load,
    analysis,
    cache,
    job,
    jobError,
    notes,
    notice,
    clearNotice,
    runReview,
    cancelReview,
    addNote,
    deleteNote,
    patchNote,
  };
}
