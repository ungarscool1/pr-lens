import type { Analysis, CacheInfo, Estimate } from '../../../../shared/review';
import { Blueprint, Icon } from '../../ds';
import type { Job } from './useReview';

interface Props {
  estimate: Estimate;
  analysis: Analysis | null;
  cache: CacheInfo | null;
  /** Only review jobs; release jobs report in their own card. */
  job: Job | null;
  jobError: string | null;
  stats: { high: number; medium: number; mine: number; seen: number };
  onRun: () => void;
  onCancel: () => void;
}

/** The "PR Lens summary" card with severity counts, shared by PR and compare views. */
export function SummaryCard({
  estimate,
  analysis,
  cache,
  job,
  jobError,
  stats,
  onRun,
  onCancel,
}: Props) {
  return (
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
        ) : estimate.blocked ? (
          <p>{estimate.blocked}</p>
        ) : (
          <>
            <p>
              Not reviewed yet. About {Math.round(estimate.inputTokens / 1000)}k input tokens
              {estimate.chunks > 1 ? `, in ${estimate.chunks} chunks plus a merge pass` : ''}.
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
  );
}
