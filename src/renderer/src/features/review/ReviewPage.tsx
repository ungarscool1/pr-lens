import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DiffFile as DiffFileModel } from '../../../../shared/diff';
import { noiseKind } from '../../../../shared/diff';
import type { OpenResult, PromotePreview } from '../../../../shared/ipc';
import type { ReviewDecision } from '../../../../shared/ipc';
import type { DiffMode } from '../../../../shared/subject';
import type { FileRisk } from '../../../../shared/review';
import { Icon, Seg } from '../../ds';
import { DiffFile, fileDomId, lineDomId } from './DiffFile';
import { GitHubContext } from './GitHubContext';
import { ImpactView } from './ImpactView';
import { navigableNotes, passesFilter, stepNote, toViewNotes } from './model';
import type { ComposerAt, Filter, ViewMode, ViewNote } from './model';
import { noteDomId } from './NoteView';
import type { RefTarget } from './NoteView';
import { PromoteDialog } from '../promote/PromoteDialog';
import { ReviewSubmitDialog } from '../promote/ReviewSubmitDialog';
import { CompareHeader } from './CompareHeader';
import { PrHeader } from './PrHeader';
import { SummaryCard } from './SummaryCard';
import { Sidebar } from './Sidebar';
import { api, errorMessage, run } from '../../lib/api';
import { useReview } from './useReview';
import type { ReviewState, Source } from './useReview';

type Density = 'comfortable' | 'compact';
type ReviewContent = 'diff' | 'impact';

const sourceLabel = (s: Source): string =>
  s.kind === 'pr' ? s.input : `${s.owner}/${s.repo} ${s.base} → ${s.head}`;

export function ReviewPage({
  source,
  active,
  autoRunMaxTokens,
  promoteEnabled,
  onMode,
}: {
  source: Source;
  active: boolean;
  autoRunMaxTokens: number;
  /** The opt-in setting for writing pending review comments. */
  promoteEnabled: boolean;
  /** Compare only: switch between merge-base and direct diffs. */
  onMode?: (mode: DiffMode) => void;
}) {
  const review = useReview(source, autoRunMaxTokens);
  const { load } = review;
  if (load.status === 'loading') {
    return (
      <div className="page-msg" role="status">
        <p>Loading {sourceLabel(source)}…</p>
      </div>
    );
  }
  if (load.status === 'error') {
    return (
      <div className="page-msg" role="alert">
        <h2>
          {source.kind === 'pr'
            ? 'Could not open this pull request'
            : 'Could not compare these refs'}
        </h2>
        <p>{load.message}</p>
      </div>
    );
  }
  return (
    <LoadedReview
      open={load.open}
      review={review}
      active={active}
      promoteEnabled={promoteEnabled}
      onMode={onMode}
    />
  );
}

function LoadedReview({
  open,
  review,
  active,
  promoteEnabled,
  onMode,
}: {
  open: OpenResult;
  review: ReviewState;
  active: boolean;
  promoteEnabled: boolean;
  onMode: ((mode: DiffMode) => void) | undefined;
}) {
  const { analysis, notes: notesFile, patchNote, addNote, deleteNote } = review;
  const noteState = notesFile.state;
  const [mode, setMode] = useState<ViewMode>('unified');
  const [filter, setFilter] = useState<Filter>('all');
  const [density, setDensity] = useState<Density>('comfortable');
  const [content, setContent] = useState<ReviewContent>('diff');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [viewed, setViewed] = useState<Record<string, boolean>>({});
  const [loadedNoise, setLoadedNoise] = useState<Record<string, boolean>>({});
  const [current, setCurrent] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerAt | null>(null);
  const [scrollTo, setScrollTo] = useState<{ id: string; focus: boolean } | null>(null);

  const files = open.diff.files;
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
  const shown = useMemo(
    () =>
      allNotes.filter(
        (n) =>
          passesFilter(n, filter) &&
          (filter !== 'unseen' || (!noteState[n.id]?.seen && !noteState[n.id]?.dismissed)),
      ),
    [allNotes, filter, noteState],
  );
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
  const jumpPath = (path: string): void => {
    const file = files.find((candidate) => candidate.path === path);
    if (file) jumpFile(file.fid);
  };

  const [askingNoteId, setAskingNoteId] = useState<string | null>(null);
  const { notify } = review;
  const askClaude = useCallback(
    (noteId: string) => {
      if (askingNoteId) return;
      setAskingNoteId(noteId);
      run(api.deepDive.open({ targetKey: open.target.key, noteId }))
        .then((r) =>
          notify(`Opened in ${r.terminalApp} · ${r.worktreePath.split('/').pop() ?? ''}`),
        )
        .catch((e: unknown) => notify(errorMessage(e)))
        .finally(() => setAskingNoteId(null));
    },
    [askingNoteId, open.target.key, notify],
  );

  const [promote, setPromote] = useState<{ preview: PromotePreview; noteId: string } | null>(null);
  const [promoteBusy, setPromoteBusy] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const promoteBlocked =
    open.target.subject.kind !== 'pr'
      ? 'Only notes on a pull request can become review comments'
      : promoteEnabled
        ? null
        : 'Turn on Promote to comment in Settings first';
  const { setLocalNoteState } = review;
  const startPromote = useCallback(
    (noteId: string) => {
      setPromoteError(null);
      run(api.promote.preview({ targetKey: open.target.key, noteId }))
        .then((preview) => setPromote({ preview, noteId }))
        .catch((e: unknown) => notify(errorMessage(e)));
    },
    [open.target.key, notify, setPromote, setPromoteError],
  );
  const confirmPromote = (body: string): void => {
    if (!promote) return;
    setPromoteBusy(true);
    setPromoteError(null);
    run(api.promote.confirm({ confirmToken: promote.preview.confirmToken, body }))
      .then(() => {
        setLocalNoteState(promote.noteId, { promoted: true });
        setPromote(null);
        notify(
          'Added to your pending review on GitHub. Submit the review there when you are ready.',
        );
      })
      // The token is single-use: a failed confirm closes nothing but needs a fresh preview.
      .catch((e: unknown) => {
        setPromoteError(`${errorMessage(e)} Close and try again.`);
      })
      .finally(() => setPromoteBusy(false));
  };
  const [reviewSubmit, setReviewSubmit] = useState<ReviewDecision | null>(null);
  const [reviewSubmitBusy, setReviewSubmitBusy] = useState(false);
  const [reviewSubmitError, setReviewSubmitError] = useState<string | null>(null);
  const stagedCount = allNotes.filter((n) => noteState[n.id]?.promoted).length;
  const submitReview = (body: string): void => {
    if (!reviewSubmit) return;
    setReviewSubmitBusy(true);
    setReviewSubmitError(null);
    run(api.promote.submitReview({ targetKey: open.target.key, event: reviewSubmit, body }))
      .then(() => {
        // `promoted` means "in your pending review". Submission ends that pending state;
        // local notes remain in place and are never part of this request.
        for (const n of allNotes)
          if (noteState[n.id]?.promoted) patchNote(n.id, { promoted: false });
        setReviewSubmit(null);
        notify('Review submitted to GitHub. Private notes remain local.');
      })
      .catch((e: unknown) => setReviewSubmitError(errorMessage(e)))
      .finally(() => setReviewSubmitBusy(false));
  };

  // Global review shortcuts, ignored while typing or while another view is shown.
  useEffect(() => {
    // While the promote dialog is open it owns the keyboard.
    if (!active || promote || reviewSubmit) return;
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
      } else if (e.key === 'a' && cur) {
        askClaude(cur.id);
      } else if (e.key === 'd' && cur?.source === 'ai') {
        patchNote(cur.id, { dismissed: true });
        const next = stepNote(nav, current, 1);
        if (next && next.id !== cur.id) jumpNote(next);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    active,
    promote,
    reviewSubmit,
    nav,
    allNotes,
    current,
    noteState,
    jumpNote,
    patchNote,
    askClaude,
  ]);

  const aiNotes = analysis?.notes ?? [];
  const stats = {
    high: aiNotes.filter((n) => n.severity === 'high').length,
    medium: aiNotes.filter((n) => n.severity === 'medium').length,
    mine: notesFile.mine.length,
    seen: allNotes.filter((n) => noteState[n.id]?.seen).length,
  };
  const unseen = allNotes.filter(
    (n) => !noteState[n.id]?.seen && !noteState[n.id]?.dismissed,
  ).length;
  const summary = (
    <SummaryCard
      estimate={open.estimate}
      analysis={analysis}
      cache={review.cache}
      job={review.job?.kind === 'review' ? review.job : null}
      jobError={review.jobError?.kind === 'review' ? review.jobError.message : null}
      stats={stats}
      headSha={open.target.headSha}
      onRun={() => review.runReview(false)}
      onCancel={review.cancelReview}
    />
  );
  const viewedCount = reviewed.filter((f) => viewed[f.fid]).length;
  const saveNote = useCallback(
    (at: ComposerAt, body: string) => {
      const path = files.find((f) => f.fid === at.fid)?.path ?? '';
      return addNote(at, path, body);
    },
    [files, addNote],
  );

  return (
    <div className={`review density-${density}`}>
      <Sidebar
        files={files}
        orderedFiles={reviewed}
        risks={risks}
        notes={allNotes}
        noteState={noteState}
        analysis={analysis}
        cache={review.cache}
        estimate={open.estimate}
        headSha={open.target.headSha}
        job={review.job}
        onJumpFile={jumpFile}
        onJumpNote={jumpNote}
        onRerun={() => review.runReview(true)}
      />
      <div className="review-main-wrap">
        <main className="review-main">
          {open.header.kind === 'compare' ? (
            <CompareHeader
              meta={open.header.meta}
              release={review.release}
              releaseJob={review.job?.kind === 'release' ? review.job : null}
              releaseError={review.jobError?.kind === 'release' ? review.jobError.message : null}
              noteTitle={(id) => aiNotes.find((n) => n.id === id)?.title ?? null}
              onMode={(m) => onMode?.(m)}
              onRelease={review.runRelease}
              onCancel={review.cancelReview}
              onJumpNote={(id) => {
                const n = allNotes.find((x) => x.id === id);
                if (n) jumpNote(n);
              }}
            >
              {summary}
            </CompareHeader>
          ) : (
            open.target.subject.kind === 'pr' && (
              <PrHeader
                prRef={open.target.subject.ref}
                meta={open.header.meta}
                canSubmitReview={promoteEnabled}
                onSubmitReview={(event) => {
                  setReviewSubmitError(null);
                  setReviewSubmit(event);
                }}
              >
                {summary}
                <GitHubContext prRef={open.target.subject.ref} onJumpPath={jumpPath} />
              </PrHeader>
            )
          )}
          <div className="toolbar" role="toolbar" aria-label="Diff view">
            <Seg<ReviewContent>
              name="review-content"
              label="Review content"
              value={content}
              onChange={setContent}
              options={[
                { value: 'diff', label: 'Diff' },
                { value: 'impact', label: 'Impact' },
              ]}
            />
            {content === 'diff' && (
              <>
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
                      value: 'unseen',
                      label: (
                        <>
                          Unseen <span className="seg-count">{unseen}</span>
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
                      value: 'medium',
                      label: (
                        <>
                          Medium <span className="seg-count">{stats.medium}</span>
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
                  <button
                    className="btn btn-secondary nav-note"
                    onClick={() => {
                      const previous = stepNote(nav, current, -1);
                      if (previous) jumpNote(previous);
                    }}
                    disabled={!nav.length}
                  >
                    <Icon name="arrowUp" />
                    Previous
                  </button>
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
                  <Seg<Density>
                    name="density"
                    label="Review density"
                    value={density}
                    onChange={setDensity}
                    options={[
                      { value: 'comfortable', label: 'Comfortable' },
                      { value: 'compact', label: 'Compact' },
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
              </>
            )}
          </div>
          {content === 'diff' ? (
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
                  onAskNote={askClaude}
                  askingNoteId={askingNoteId}
                  onPromoteNote={startPromote}
                  promoteBlocked={promoteBlocked}
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
                    onAskNote={askClaude}
                    askingNoteId={askingNoteId}
                    onPromoteNote={startPromote}
                    promoteBlocked={promoteBlocked}
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
          ) : (
            <ImpactView targetKey={open.target.key} onJumpPath={jumpPath} />
          )}
        </main>
        {promote && (
          <PromoteDialog
            preview={promote.preview}
            busy={promoteBusy}
            error={promoteError}
            onCancel={() => setPromote(null)}
            onConfirm={confirmPromote}
          />
        )}
        {reviewSubmit && (
          <ReviewSubmitDialog
            event={reviewSubmit}
            stagedCount={stagedCount}
            busy={reviewSubmitBusy}
            error={reviewSubmitError}
            onCancel={() => setReviewSubmit(null)}
            onSubmit={submitReview}
          />
        )}
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
