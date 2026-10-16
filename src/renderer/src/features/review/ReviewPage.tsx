import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DiffFile as DiffFileModel } from '../../../../shared/diff';
import { noiseKind } from '../../../../shared/diff';
import type { OpenPrResult } from '../../../../shared/ipc';
import type { FileRisk } from '../../../../shared/review';
import { Icon, Seg } from '../../ds';
import { DiffFile, fileDomId, lineDomId } from './DiffFile';
import { navigableNotes, passesFilter, stepNote, toViewNotes } from './model';
import type { ComposerAt, Filter, ViewMode, ViewNote } from './model';
import { noteDomId } from './NoteView';
import type { RefTarget } from './NoteView';
import { PrHeader } from './PrHeader';
import { Sidebar } from './Sidebar';
import { useReview } from './useReview';
import type { ReviewState } from './useReview';
import './review.css';

export function ReviewPage({
  input,
  active,
  autoRunMaxTokens,
}: {
  input: string;
  active: boolean;
  autoRunMaxTokens: number;
}) {
  const review = useReview(input, autoRunMaxTokens);
  const { load } = review;
  if (load.status === 'loading') {
    return (
      <div className="page-msg" role="status">
        <p>Loading {input}…</p>
      </div>
    );
  }
  if (load.status === 'error') {
    return (
      <div className="page-msg" role="alert">
        <h2>Could not open this pull request</h2>
        <p>{load.message}</p>
      </div>
    );
  }
  return <LoadedReview pr={load.pr} review={review} active={active} />;
}

function LoadedReview({
  pr,
  review,
  active,
}: {
  pr: OpenPrResult;
  review: ReviewState;
  active: boolean;
}) {
  const { analysis, notes: notesFile, patchNote, addNote, deleteNote } = review;
  const noteState = notesFile.state;
  const [mode, setMode] = useState<ViewMode>('unified');
  const [filter, setFilter] = useState<Filter>('all');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [viewed, setViewed] = useState<Record<string, boolean>>({});
  const [loadedNoise, setLoadedNoise] = useState<Record<string, boolean>>({});
  const [current, setCurrent] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerAt | null>(null);
  const [scrollTo, setScrollTo] = useState<{ id: string; focus: boolean } | null>(null);

  const files = pr.diff.files;
  const risks = useMemo(
    () => new Map<string, FileRisk>((analysis?.files ?? []).map((f) => [f.fid, f])),
    [analysis],
  );
  const reviewed = useMemo(() => {
    const byId = new Map(files.map((f) => [f.fid, f]));
    const order = analysis?.readingOrder ?? files.filter((f) => f.noise === null).map((f) => f.fid);
    return order
      .map((id) => byId.get(id))
      .filter((f): f is DiffFileModel => !!f && f.noise === null);
  }, [files, analysis]);
  const noise = files.filter((f) => f.noise !== null);

  const allNotes = useMemo(
    () => toViewNotes(analysis?.notes ?? [], notesFile.mine),
    [analysis, notesFile.mine],
  );
  const shown = useMemo(() => allNotes.filter((n) => passesFilter(n, filter)), [allNotes, filter]);
  const notesByFile = useMemo(() => {
    const m = new Map<string, ViewNote[]>();
    for (const n of shown) m.set(n.fid, [...(m.get(n.fid) ?? []), n]);
    return m;
  }, [shown]);
  const nav = useMemo(
    () => navigableNotes(allNotes, noteState, filter),
    [allNotes, noteState, filter],
  );

  const lineIndex = useMemo(() => {
    const m = new Map<string, RefTarget>();
    for (const f of files) {
      const base = f.path.slice(f.path.lastIndexOf('/') + 1);
      m.set(f.fid, { label: base, domId: fileDomId(f.fid) });
      for (const h of f.hunks) {
        for (const l of h.lines)
          m.set(l.id, { label: `${base}:${l.new ?? l.old ?? ''}`, domId: lineDomId(l.id) });
      }
    }
    return m;
  }, [files]);
  const resolveRef = useCallback((id: string) => lineIndex.get(id) ?? null, [lineIndex]);

  useEffect(() => {
    if (!scrollTo) return;
    const el = document.getElementById(scrollTo.id);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (scrollTo.focus) el?.focus({ preventScroll: true });
  }, [scrollTo]);

  const openFile = (fid: string): void => {
    setClosed((c) => ({ ...c, [fid]: false }));
    setViewed((v) => ({ ...v, [fid]: false }));
  };
  const jumpNote = useCallback(
    (n: ViewNote) => {
      setCurrent(n.id);
      openFile(n.fid);
      if (noteState[n.id]?.collapsed) patchNote(n.id, { collapsed: false });
      setScrollTo({ id: noteDomId(n.id), focus: true });
    },
    [noteState, patchNote],
  );
  const jumpFile = (fid: string): void => {
    setClosed((c) => ({ ...c, [fid]: false }));
    setScrollTo({ id: fileDomId(fid), focus: false });
  };

  // Global review shortcuts, ignored while typing or while another view is shown.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))
        return;
      const cur = nav.find((n) => n.id === current) ?? allNotes.find((n) => n.id === current);
      if (e.key === 'j' || e.key === 'k') {
        const next = stepNote(nav, current, e.key === 'j' ? 1 : -1);
        if (next) jumpNote(next);
      } else if (e.key === 's' && cur) {
        const seen = !noteState[cur.id]?.seen;
        patchNote(cur.id, { seen, collapsed: seen });
      } else if (e.key === 'd' && cur?.source === 'ai') {
        patchNote(cur.id, { dismissed: true });
        const next = stepNote(nav, current, 1);
        if (next && next.id !== cur.id) jumpNote(next);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, nav, allNotes, current, noteState, jumpNote, patchNote]);

  const aiNotes = analysis?.notes ?? [];
  const stats = {
    high: aiNotes.filter((n) => n.severity === 'high').length,
    medium: aiNotes.filter((n) => n.severity === 'medium').length,
    mine: notesFile.mine.length,
    seen: allNotes.filter((n) => noteState[n.id]?.seen).length,
  };
  const viewedCount = reviewed.filter((f) => viewed[f.fid]).length;
  const saveNote = useCallback(
    (at: ComposerAt, body: string) => {
      const path = files.find((f) => f.fid === at.fid)?.path ?? '';
      return addNote(at, path, body);
    },
    [files, addNote],
  );

  return (
    <div className="review">
      <Sidebar
        files={files}
        orderedFiles={reviewed}
        risks={risks}
        notes={allNotes}
        noteState={noteState}
        analysis={analysis}
        estimate={pr.estimate}
        headSha={pr.target.headSha}
        job={review.job}
        onJumpFile={jumpFile}
        onJumpNote={jumpNote}
        onRerun={() => review.runReview(true)}
      />
      <div className="review-main-wrap">
        <main className="review-main">
          <PrHeader
            pr={pr}
            analysis={analysis}
            job={review.job}
            jobError={review.jobError}
            stats={stats}
            onRun={() => review.runReview(false)}
            onCancel={review.cancelReview}
          />
          <div className="toolbar" role="toolbar" aria-label="Diff view">
            <div className="viewed">
              <span>
                {viewedCount}/{reviewed.length} viewed
              </span>
              <span className="viewed-bar" aria-hidden="true">
                <span
                  style={{
                    width: `${reviewed.length ? (100 * viewedCount) / reviewed.length : 0}%`,
                  }}
                />
              </span>
            </div>
            <Seg<Filter>
              name="filter"
              label="Filter notes"
              value={filter}
              onChange={setFilter}
              options={[
                {
                  value: 'all',
                  label: (
                    <>
                      All <span className="seg-count">{allNotes.length}</span>
                    </>
                  ),
                },
                {
                  value: 'high',
                  label: (
                    <>
                      High <span className="seg-count">{stats.high}</span>
                    </>
                  ),
                },
                {
                  value: 'mine',
                  label: (
                    <>
                      Mine <span className="seg-count">{stats.mine}</span>
                    </>
                  ),
                },
              ]}
            />
            <div className="toolbar-right">
              <Seg<ViewMode>
                name="view"
                label="Diff layout"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'unified', label: 'Unified' },
                  { value: 'split', label: 'Split' },
                ]}
              />
              <button
                className="btn btn-secondary"
                onClick={() => {
                  const next = stepNote(nav, current, 1);
                  if (next) jumpNote(next);
                }}
                disabled={!nav.length}
              >
                <Icon name="arrowDown" />
                Next note
              </button>
            </div>
          </div>
          <div className="files">
            {reviewed.map((f) => (
              <DiffFile
                key={f.fid}
                file={f}
                risk={risks.get(f.fid)}
                notes={notesByFile.get(f.fid) ?? EMPTY}
                noteState={noteState}
                mode={mode}
                open={!closed[f.fid] && !viewed[f.fid]}
                viewed={!!viewed[f.fid]}
                currentNoteId={current}
                composer={composer?.fid === f.fid ? composer : null}
                onToggleOpen={() => {
                  const isOpen = !closed[f.fid] && !viewed[f.fid];
                  setClosed((c) => ({ ...c, [f.fid]: isOpen }));
                  setViewed((v) => ({ ...v, [f.fid]: false }));
                }}
                onToggleViewed={() => setViewed((v) => ({ ...v, [f.fid]: !v[f.fid] }))}
                onCompose={setComposer}
                onSaveNote={saveNote}
                onPatchNote={patchNote}
                onDeleteNote={deleteNote}
                resolveRef={resolveRef}
                onJumpRef={(id) => setScrollTo({ id, focus: false })}
              />
            ))}
            {noise.map((f) =>
              loadedNoise[f.fid] ? (
                <DiffFile
                  key={f.fid}
                  file={f}
                  risk={undefined}
                  notes={notesByFile.get(f.fid) ?? EMPTY}
                  noteState={noteState}
                  mode={mode}
                  open
                  viewed={false}
                  currentNoteId={current}
                  composer={composer?.fid === f.fid ? composer : null}
                  onToggleOpen={() => setLoadedNoise((s) => ({ ...s, [f.fid]: false }))}
                  onToggleViewed={() => setLoadedNoise((s) => ({ ...s, [f.fid]: false }))}
                  onCompose={setComposer}
                  onSaveNote={saveNote}
                  onPatchNote={patchNote}
                  onDeleteNote={deleteNote}
                  resolveRef={resolveRef}
                  onJumpRef={(id) => setScrollTo({ id, focus: false })}
                />
              ) : (
                <section key={f.fid} className="noise-file" aria-label={`${f.path}, collapsed`}>
                  <span>{f.path}</span>
                  <span className="tag tag-neutral">{noiseKind(f.noise ?? '')}</span>
                  <span className="rule">
                    +{f.additions} −{f.deletions} · collapsed by noise rule <b>{f.noise}</b>
                  </span>
                  <button
                    className="link"
                    onClick={() => setLoadedNoise((s) => ({ ...s, [f.fid]: true }))}
                  >
                    Load diff
                  </button>
                </section>
              ),
            )}
          </div>
        </main>
        {review.notice && (
          <div className="notice" role="alert">
            {review.notice}
            <button
              className="btn btn-ghost icon-btn"
              aria-label="Dismiss message"
              onClick={review.clearNotice}
            >
              <Icon name="x" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const EMPTY: ViewNote[] = [];
