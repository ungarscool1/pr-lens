import { useCallback, useEffect, useState } from 'react';
import type { Inbox, InboxPullRequest, InboxReviewRequest } from '../../../../shared/inbox';
import { Icon, Seg } from '../../ds';
import { api, errorMessage, run } from '../../lib/api';

interface Props {
  onOpen: (input: string) => void;
}

const relativeTime = (iso: string): string => {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
};

const decision = (pr: InboxPullRequest): string => {
  if (pr.reviewDecision === 'APPROVED') return 'Approved';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'Changes requested';
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return 'Review required';
  return pr.reviewRequestCount ? `${pr.reviewRequestCount} pending review request${pr.reviewRequestCount === 1 ? '' : 's'}` : 'No review decision yet';
};

function PullRequestCard({ pr, requestedAs, onOpen }: { pr: InboxPullRequest; requestedAs?: string; onOpen: () => void }) {
  return (
    <button className="inbox-pr" onClick={onOpen}>
      <span className="inbox-pr-main">
        <span className="inbox-pr-title">{pr.title}</span>
        <span className="inbox-pr-repo">
          {pr.owner}/{pr.repo} <b>#{pr.number}</b> · opened by {pr.author}
        </span>
      </span>
      <span className="inbox-pr-status">
        <span>{requestedAs ? `Requested for ${requestedAs}` : decision(pr)}</span>
        <span className="inbox-pr-time">Updated {relativeTime(pr.updatedAt)}</span>
      </span>
      <Icon name="chevronRight" />
    </button>
  );
}

function PullRequestList({
  prs,
  onOpen,
}: {
  prs: (InboxPullRequest | InboxReviewRequest)[];
  onOpen: (pr: InboxPullRequest) => void;
}) {
  return (
    <section className="inbox-section">
      {prs.length ? (
        <div className="inbox-list">
          {prs.map((pr) => (
            <PullRequestCard
              key={`${pr.owner}/${pr.repo}#${pr.number}`}
              pr={pr}
              requestedAs={'requestedAs' in pr ? pr.requestedAs : undefined}
              onOpen={() => onOpen(pr)}
            />
          ))}
        </div>
      ) : (
        <p className="inbox-empty">Nothing here right now.</p>
      )}
    </section>
  );
}

/** Home: the viewer's authored open PRs and review requests directed to them or their teams. */
export function InboxPage({ onOpen }: Props) {
  const [data, setData] = useState<Inbox | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'authored' | 'requested'>('authored');

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    run(api.github.inbox())
      .then(setData)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    // Queue the initial load: React's effect lint treats the network callback, not this render,
    // as the state transition that owns the result.
    void Promise.resolve().then(refresh);
  }, [refresh]);

  if (loading && !data) {
    return (
      <main className="inbox page-msg" role="status">
        Loading your GitHub inbox…
      </main>
    );
  }
  if (error && !data) {
    return (
      <main className="inbox page-msg" role="alert">
        <h1>Could not load your inbox</h1>
        <p>{error}</p>
        <button className="btn btn-secondary" onClick={refresh}>
          Try again
        </button>
      </main>
    );
  }
  if (!data) return null;
  const isAuthored = tab === 'authored';
  const prs = isAuthored ? data.authored : data.requested;

  return (
    <main className="inbox">
      <div className="inbox-head">
        <div>
          <span className="kicker-mono">Home · GitHub</span>
          <h1>Inbox</h1>
          <p>Open pull requests that need attention from @{data.viewer}.</p>
        </div>
        <button className="btn btn-secondary" onClick={refresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {(error || data.unavailable.length > 0) && (
        <p className="inbox-refresh-error" role="status">
          {error ??
            'Some GitHub data is unavailable (for example, an organization awaiting SAML authorization). The rest of your Inbox is still shown.'}
        </p>
      )}
      <section className="inbox-results">
        <div className="inbox-tabs">
          <Seg
            name="inbox"
            label="Inbox category"
            value={tab}
            onChange={setTab}
            options={[
              {
                value: 'authored',
                label: (
                  <>
                    Your pull requests <span className="seg-count">{data.authored.length}</span>
                  </>
                ),
              },
              {
                value: 'requested',
                label: (
                  <>
                    Needs your review <span className="seg-count">{data.requested.length}</span>
                  </>
                ),
              },
            ]}
          />
          <p>
            {isAuthored
              ? 'Open PRs you authored, with their current review state.'
              : 'Direct requests and requests explicitly addressed to a GitHub team you belong to.'}
          </p>
        </div>
        <PullRequestList prs={prs} onOpen={(pr) => onOpen(`${pr.owner}/${pr.repo}#${pr.number}`)} />
      </section>
    </main>
  );
}
