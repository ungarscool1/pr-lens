import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ReleaseSummary } from '../../../../shared/review';
import { DIFF_MODE_LABELS } from '../../../../shared/subject';
import type { CompareMeta, DiffMode } from '../../../../shared/subject';
import { Blueprint, Icon, Seg } from '../../ds';
import { openExternal } from '../../lib/api';
import { diffLabel, short } from './compareLabel';
import type { Job } from './useReview';

interface Props {
  meta: CompareMeta;
  release: ReleaseSummary | null;
  /** A running release job, if any. */
  releaseJob: Job | null;
  releaseError: string | null;
  noteTitle: (id: string) => string | null;
  onMode: (mode: DiffMode) => void;
  onRelease: (force: boolean) => void;
  onCancel: () => void;
  onJumpNote: (id: string) => void;
  /** The summary card. */
  children: ReactNode;
}

export function CompareHeader(p: Props) {
  const { meta } = p;
  const [showCommits, setShowCommits] = useState(false);
  const bothTags = meta.baseIsTag && meta.headIsTag;

  return (
    <div className="pr-head">
      <nav className="crumbs" aria-label="Breadcrumb">
        <span>
          {meta.owner}/{meta.repo}
        </span>
        <span aria-hidden="true">/</span>
        <span>compare</span>
        <button className="link" onClick={() => openExternal(meta.url)}>
          Open on GitHub ↗
        </button>
      </nav>
      <h1 className="pr-title">
        {meta.base} <span>→</span> {meta.head}
      </h1>
      <div className="pr-meta">
        <span>
          <code className="ref-chip">{meta.base}</code>
          {meta.baseIsTag ? ' tag' : ''} to <code className="ref-chip">{meta.head}</code>
          {meta.headIsTag ? ' tag' : ''}
        </span>
        <span className="sha-range">
          {short(meta.baseSha)}…{short(meta.headSha)}
        </span>
        <span>
          {meta.aheadBy} commit{meta.aheadBy === 1 ? '' : 's'} ahead
          {meta.behindBy ? `, ${meta.behindBy} behind` : ''}
        </span>
      </div>
      <div className="compare-mode">
        <Seg<DiffMode>
          name="compare-mode"
          label="Diff mode"
          value={meta.mode}
          onChange={p.onMode}
          options={[
            { value: 'three-dot', label: DIFF_MODE_LABELS['three-dot'] },
            { value: 'two-dot', label: DIFF_MODE_LABELS['two-dot'] },
          ]}
        />
        <span className="tag tag-outline">{diffLabel(meta)}</span>
        <span className="compare-explainer">
          {meta.mode === 'three-dot'
            ? 'Base → merge base → head: changes introduced by head'
            : 'Base → head: direct tree-to-tree difference'}
        </span>
      </div>
      <button
        className="btn btn-ghost desc-toggle"
        aria-expanded={showCommits}
        onClick={() => setShowCommits(!showCommits)}
      >
        <Icon name="chevronRight" />
        {showCommits ? 'Hide commits' : `Show ${meta.totalCommits} commits`}
      </button>
      {showCommits && (
        <div className="desc-box">
          <span className="kicker-mono">
            Commits on head
            {meta.totalCommits > meta.commits.length
              ? ` · first ${meta.commits.length} of ${meta.totalCommits}`
              : ''}
          </span>
          <ol className="commit-list">
            {meta.commits.map((c) => (
              <li key={c.sha}>
                <code>{short(c.sha)}</code> {c.subject} <span>· {c.author}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {bothTags && (
        <Blueprint as="section" className="release" aria-labelledby="release-h">
          <span className="card-kicker" id="release-h">
            <Icon name="lens" size={13} />
            Release summary · private
          </span>
          {p.releaseJob ? (
            <>
              <p>{p.releaseJob.message}</p>
              <div className="summary-actions">
                <button
                  className="btn btn-secondary"
                  onClick={p.onCancel}
                  disabled={!p.releaseJob.id}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : p.release ? (
            <>
              <h2 className="release-headline">{p.release.headline}</h2>
              <div className="release-areas">
                {p.release.changes.map((c) => (
                  <div key={c.area}>
                    <h3>{c.area}</h3>
                    <ul>
                      {c.bullets.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              {p.release.risky.length > 0 && (
                <div className="release-risky">
                  <span className="kicker-mono">Look at first</span>
                  {p.release.risky.map((id) => (
                    <button key={id} className="ref" onClick={() => p.onJumpNote(id)}>
                      {p.noteTitle(id) ?? id}
                    </button>
                  ))}
                </div>
              )}
              <div className="summary-actions">
                <button className="btn btn-ghost" onClick={() => p.onRelease(true)}>
                  Write it again
                </button>
              </div>
            </>
          ) : (
            <>
              {p.releaseError && <p>{p.releaseError}</p>}
              <p className="summary-note">
                What changed between these two tags, grouped by area, from the commits and file
                list. If the review has run, its notes are used to pick what to look at first.
              </p>
              <div className="summary-actions">
                <button className="btn btn-secondary" onClick={() => p.onRelease(false)}>
                  Write release summary
                </button>
              </div>
            </>
          )}
        </Blueprint>
      )}

      {p.children}
    </div>
  );
}
