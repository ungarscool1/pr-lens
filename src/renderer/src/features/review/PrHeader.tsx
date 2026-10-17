import { useState } from 'react';
import type { ReactNode } from 'react';
import type { PrMeta, PrRef } from '../../../../shared/pr';
import type { ReviewDecision } from '../../../../shared/ipc';
import { Icon } from '../../ds';
import { openExternal } from '../../lib/api';

interface Props {
  prRef: PrRef;
  meta: PrMeta;
  /** The summary card. */
  children: ReactNode;
  canSubmitReview: boolean;
  onSubmitReview: (event: ReviewDecision) => void;
}

const STATE_LABEL = { OPEN: 'Open', CLOSED: 'Closed', MERGED: 'Merged' } as const;

export function PrHeader({ prRef: ref, meta, children, canSubmitReview, onSubmitReview }: Props) {
  const [showDesc, setShowDesc] = useState(false);

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
