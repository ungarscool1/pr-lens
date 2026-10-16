import { useState } from 'react';
import type { OpenPrResult } from '../../../../shared/ipc';
import type { Analysis, CacheInfo } from '../../../../shared/review';
import { Blueprint, Icon } from '../../ds';
import { api, run } from '../../lib/api';
import type { Job } from './useReview';

interface Props {
  pr: OpenPrResult;
  analysis: Analysis | null;
  cache: CacheInfo | null;
  job: Job | null;
  jobError: string | null;
  stats: { high: number; medium: number; mine: number; seen: number };
  onRun: () => void;
  onCancel: () => void;
}

const STATE_LABEL = { OPEN: 'Open', CLOSED: 'Closed', MERGED: 'Merged' } as const;

export function PrHeader({ pr, analysis, cache, job, jobError, stats, onRun, onCancel }: Props) {
  const [showDesc, setShowDesc] = useState(false);
  const { meta, target } = pr;
  const ref = target.ref;
  const openOnGitHub = (): void =>
    void run(api.shell.openExternal({ url: meta.url })).catch(() => undefined);

  return (
    <div className="pr-head">
      <nav className="crumbs" aria-label="Breadcrumb">
        <span>
          {ref.owner}/{ref.repo}
        </span>
        <span aria-hidden="true">/</span>
        <span>#{ref.number}</span>
        <button className="link" onClick={openOnGitHub}>
          Open on GitHub ↗
        </button>
      </nav>
      <h1 className="pr-title">
        {meta.title} <span>#{ref.number}</span>
      </h1>
      <div className="pr-meta">
        <span className="tag pr-state">{meta.isDraft ? 'Draft' : STATE_LABEL[meta.state]}</span>
        <span>
          <b>{meta.author}</b> wants to merge {meta.commitCount} commit
          {meta.commitCount === 1 ? '' : 's'} into{' '}
          <code className="ref-chip">{meta.baseRefName}</code> from{' '}
          <code className="ref-chip">{meta.headRefName}</code>
        </span>
        <span className="sha-range">
          {meta.baseSha.slice(0, 7)}…{meta.headSha.slice(0, 7)}
        </span>
        <span className="tag tag-outline">Three-dot · same as GitHub</span>
        {meta.linkedIssues[0] && (
          <span>
            Closes #{meta.linkedIssues[0].number} {meta.linkedIssues[0].title}
          </span>
        )}
      </div>
      <button
        className="btn btn-ghost desc-toggle"
        aria-expanded={showDesc}
        onClick={() => setShowDesc(!showDesc)}
      >
        <Icon name="chevronRight" />
        {showDesc ? 'Hide description' : 'Show description'}
        {meta.linkedIssues.length ? ' and linked issue' : ''}
      </button>
      {showDesc && (
        <div className="desc-grid">
          <div className="desc-box">
            <span className="kicker-mono">Description · {meta.author}</span>
            {/* Shown as plain text: PR bodies are untrusted, so no markdown/HTML rendering. */}
            <p className="desc-text">{meta.body.trim() || 'No description provided.'}</p>
          </div>
          {meta.linkedIssues.map((i) => (
            <div key={i.number} className="desc-box">
              <span className="kicker-mono">Linked issue #{i.number} · closes</span>
              <p className="desc-text">
                <b>{i.title}.</b> {i.body.trim()}
              </p>
            </div>
          ))}
        </div>
      )}

      <Blueprint className="summary">
        <div className="summary-text" aria-live="polite">
          <span className="card-kicker">
            <Icon name="lens" size={13} />
            PR Lens summary · private
          </span>
          {job ? (
            <>
              <p>{job.message}</p>
              <div className="summary-actions">
                <button className="btn btn-secondary" onClick={onCancel} disabled={!job.id}>
                  Cancel
                </button>
              </div>
            </>
          ) : jobError ? (
            <>
              <p>{jobError}</p>
              <div className="summary-actions">
                <button className="btn btn-secondary" onClick={onRun}>
                  Try again
                </button>
              </div>
            </>
          ) : analysis ? (
            <>
              <p>{analysis.summary}</p>
              {cache?.stale && (
                <p className="summary-note">
                  Cached from a run with other settings or prompts. Re-run to refresh it.
                </p>
              )}
              {cache && !cache.saved && (
                <p className="summary-note">
                  This review could not be saved to disk; it will be gone after a restart.
                </p>
              )}
            </>
          ) : pr.estimate.blocked ? (
            <p>{pr.estimate.blocked}</p>
          ) : (
            <>
              <p>
                Not reviewed yet. About {Math.round(pr.estimate.inputTokens / 1000)}k input tokens
                {pr.estimate.chunks > 1
                  ? `, in ${pr.estimate.chunks} chunks plus a merge pass`
                  : ''}
                .
              </p>
              <div className="summary-actions">
                <button className="btn btn-primary" onClick={onRun}>
                  Run review
                </button>
              </div>
            </>
          )}
        </div>
        <dl className="stats">
          <div className="stat">
            <dt>High</dt>
            <dd>{stats.high}</dd>
          </div>
          <div className="stat">
            <dt>Medium</dt>
            <dd>{stats.medium}</dd>
          </div>
          <div className="stat">
            <dt>Mine</dt>
            <dd>{stats.mine}</dd>
          </div>
          <div className="stat">
            <dt>Seen</dt>
            <dd>{stats.seen}</dd>
          </div>
        </dl>
      </Blueprint>
    </div>
  );
}
