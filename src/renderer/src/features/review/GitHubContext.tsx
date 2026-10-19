import { useEffect, useState } from 'react';
import type { GitHubContext as GitHubContextData } from '../../../../shared/github-context';
import type { PrRef } from '../../../../shared/pr';
import { Icon } from '../../ds';
import { errorMessage, openExternal, run, api } from '../../lib/api';

interface Props {
  prRef: PrRef;
  onJumpPath: (path: string) => void;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; key: string; message: string }
  | { kind: 'ready'; key: string; context: GitHubContextData };

const contextKey = (ref: PrRef): string => `${ref.owner}/${ref.repo}#${ref.number}`;
const label = (value: string): string => value.replace(/_/g, ' ').toLowerCase();

export function GitHubContext({ prRef, onJumpPath }: Props) {
  const key = contextKey(prRef);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [request, setRequest] = useState(0);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let live = true;
    run(api.github.prContext({ input: prRef }))
      .then((context) => live && setState({ kind: 'ready', key, context }))
      .catch(
        (error: unknown) => live && setState({ kind: 'error', key, message: errorMessage(error) }),
      );
    return () => {
      live = false;
    };
  }, [key, prRef, request]);

  const refresh = (): void => {
    setState({ kind: 'loading' });
    setRequest((n) => n + 1);
  };

  if (state.kind === 'loading' || state.key !== key) {
    return (
      <section className="github-context" aria-label="GitHub context">
        <span className="github-context-status">Loading GitHub context…</span>
      </section>
    );
  }
  if (state.kind === 'error') {
    return (
      <section className="github-context" aria-label="GitHub context">
        <span className="github-context-status">GitHub context unavailable: {state.message}</span>
        <button className="btn btn-ghost" onClick={refresh}>
          Retry
        </button>
      </section>
    );
  }

  const { context } = state;
  const ownerCount = new Set(context.ownership.rules.flatMap((rule) => rule.owners)).size;
  return (
    <section className="github-context" aria-label="GitHub context">
      <header className="github-context-head">
        <div className="github-context-overview">
          <h2>GitHub context</h2>
          <div className="github-context-metrics" aria-label="GitHub context summary">
            <span className="github-context-metric">
              <b>{context.requestedReviewers.length}</b> requested
            </span>
            <span className="github-context-metric">
              <b>{context.reviews.length}</b> reviews
            </span>
            <span className="github-context-metric">
              <b>{context.unresolvedThreads.length}</b> open threads
            </span>
            <span className="github-context-metric">
              <b>{context.checks.length}</b> checks
            </span>
            <span className="github-context-metric">
              <b>{ownerCount}</b> {ownerCount === 1 ? 'owner' : 'owners'}
            </span>
          </div>
        </div>
        <div className="github-context-actions">
          <button className="btn btn-ghost" onClick={refresh}>
            Refresh
          </button>
          <button
            className="btn btn-secondary github-context-toggle"
            aria-expanded={expanded}
            aria-controls="github-context-details"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Hide' : 'Details'}
            <Icon
              name="chevronDown"
              size={14}
              style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
            />
          </button>
        </div>
      </header>
      {expanded && (
        <div className="github-context-grid" id="github-context-details">
          <section className="github-context-section">
            <h3>Reviewers</h3>
            {context.requestedReviewers.length ? (
              <p className="github-context-requested">
                <b>Requested</b>{' '}
                {context.requestedReviewers
                  .map((reviewer) =>
                    reviewer.kind === 'team' ? `@${reviewer.handle}` : reviewer.handle,
                  )
                  .join(' · ')}
              </p>
            ) : (
              <p className="github-context-requested">No reviewers currently requested.</p>
            )}
            {context.reviews.length ? (
              <ul className="github-context-list">
                {context.reviews.map((review, index) => (
                  <li key={`${review.author}:${review.submittedAt ?? index}`}>
                    <button
                      disabled={!review.url}
                      onClick={() => review.url && openExternal(review.url)}
                    >
                      <span>
                        <b>{review.author}</b> {label(review.state)}
                      </span>
                      <small>{review.body || 'No review message.'}</small>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No completed reviews yet.</p>
            )}
          </section>
          <section className="github-context-section">
            <h3>Unresolved conversations</h3>
            {context.unresolvedThreads.length ? (
              <ul className="github-context-list">
                {context.unresolvedThreads.map((thread, index) => (
                  <li key={`${thread.url ?? thread.path ?? 'thread'}:${index}`}>
                    <button
                      disabled={!thread.path}
                      onClick={() => thread.path && onJumpPath(thread.path)}
                    >
                      <span>
                        <b>{thread.author}</b>
                        {thread.path
                          ? ` · ${thread.path}${thread.line ? `:${thread.line}` : ''}`
                          : ''}
                        {thread.outdated ? ' · outdated' : ''}
                      </span>
                      <small>{thread.body || 'No comment text.'}</small>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No unresolved conversations.</p>
            )}
          </section>
          <section className="github-context-section">
            <h3>CI checks</h3>
            {context.checks.length ? (
              <ul className="github-context-list">
                {context.checks.map((check, index) => (
                  <li key={`${check.name}:${index}`}>
                    <button
                      disabled={!check.detailsUrl}
                      onClick={() => check.detailsUrl && openExternal(check.detailsUrl)}
                    >
                      <span>
                        <b>{check.name}</b>
                      </span>
                      <small>{label(check.conclusion ?? check.status)}</small>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No checks reported for this commit.</p>
            )}
          </section>
          <section className="github-context-section">
            <h3>Ownership</h3>
            {context.ownership.sourcePath ? (
              <p className="github-context-requested">
                From <b>{context.ownership.sourcePath}</b>
              </p>
            ) : (
              <p>No CODEOWNERS file on the base branch.</p>
            )}
            {context.ownership.rules.length ? (
              <ul className="github-context-list">
                {context.ownership.rules.map((rule) => (
                  <li key={`${rule.pattern}:${rule.owners.join(':')}`}>
                    <span>
                      <b>{rule.owners.join(' · ')}</b>
                      {' · '}
                      {rule.pattern}
                    </span>
                    <small title={rule.paths.join(', ')}>
                      {rule.paths.length} changed {rule.paths.length === 1 ? 'file' : 'files'}
                    </small>
                  </li>
                ))}
              </ul>
            ) : context.ownership.sourcePath ? (
              <p>No matching ownership rules.</p>
            ) : null}
            {context.ownership.unownedPaths.length > 0 && (
              <p className="github-context-requested">
                {context.ownership.unownedPaths.length} changed{' '}
                {context.ownership.unownedPaths.length === 1 ? 'file has' : 'files have'} no owner.
              </p>
            )}
          </section>
        </div>
      )}
      {expanded && context.truncated && (
        <p className="github-context-note">
          GitHub returned the first 100 items in one or more lists.
        </p>
      )}
    </section>
  );
}
