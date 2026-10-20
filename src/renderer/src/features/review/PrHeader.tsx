import { useState } from 'react';
import type { ReactNode } from 'react';
import type { PrMeta, PrRef } from '../../../../shared/pr';
import type { ReviewDecision } from '../../../../shared/ipc';
import { Icon } from '../../ds';
import { openExternal } from '../../lib/api';
import { Markdown } from './Markdown';

interface Props {
  prRef: PrRef;
  meta: PrMeta;
  /** The summary card. */
  children: ReactNode;
  canSubmitReview: boolean;
  refreshing: boolean;
  refreshDisabled: boolean;
  onRefresh: () => void;
  onSubmitReview: (event: ReviewDecision) => void;
}

const STATE_LABEL = { OPEN: 'Open', CLOSED: 'Closed', MERGED: 'Merged' } as const;

/** `#n` in an issue body refers to the issue's own repository, which may differ from the PR's. */
const repoOfIssue = (url: string, fallback: PrRef): { owner: string; repo: string } => {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/\d+/.exec(url);
  return match?.[1] && match[2] ? { owner: match[1], repo: match[2] } : fallback;
};

export function PrHeader({
  prRef: ref,
  meta,
  children,
  canSubmitReview,
  refreshing,
  refreshDisabled,
  onRefresh,
  onSubmitReview,
}: Props) {
  const [showDesc, setShowDesc] = useState(false);
  // Relative links in a description point into the repository at the reviewed commit.
  const base = `https://github.com/${ref.owner}/${ref.repo}/blob/${meta.headSha}/`;

  return (
    <div className="pr-head">
      <nav className="crumbs" aria-label="Breadcrumb">
        <span>
          {ref.owner}/{ref.repo}
        </span>
        <span aria-hidden="true">/</span>
        <span>#{ref.number}</span>
        <button className="link" onClick={() => openExternal(meta.url)}>
          Open on GitHub ↗
        </button>
        <button
          className="link crumb-refresh"
          disabled={refreshDisabled}
          title="Fetch the latest PR branch and run a fresh review"
          onClick={onRefresh}
        >
          <Icon name="refresh" />
          {refreshing ? 'Refreshing…' : 'Refresh PR'}
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
            {meta.body.trim() ? (
              <Markdown text={meta.body} repo={ref} base={base} />
            ) : (
              <p className="desc-text">No description provided.</p>
            )}
          </div>
          {meta.linkedIssues.map((i) => (
            <div key={i.number} className="desc-box">
              <span className="kicker-mono">Linked issue #{i.number} · closes</span>
              <b className="desc-title">{i.title}</b>
              {i.body.trim() && (
                <Markdown text={i.body} repo={repoOfIssue(i.url, ref)} base={base} />
              )}
            </div>
          ))}
        </div>
      )}

      <div className="review-actions" aria-label="Pull request review actions">
        <span className="kicker-mono">GitHub review</span>
        <button
          className="btn btn-secondary"
          disabled={!canSubmitReview}
          title={canSubmitReview ? undefined : 'Turn on Promote to comment in Settings first'}
          onClick={() => onSubmitReview('APPROVE')}
        >
          Approve
        </button>
        <button
          className="btn btn-secondary"
          disabled={!canSubmitReview}
          title={canSubmitReview ? undefined : 'Turn on Promote to comment in Settings first'}
          onClick={() => onSubmitReview('COMMENT')}
        >
          Comment
        </button>
        <button
          className="btn btn-primary"
          disabled={!canSubmitReview}
          title={canSubmitReview ? undefined : 'Turn on Promote to comment in Settings first'}
          onClick={() => onSubmitReview('REQUEST_CHANGES')}
        >
          Request changes
        </button>
      </div>

      {children}
    </div>
  );
}
