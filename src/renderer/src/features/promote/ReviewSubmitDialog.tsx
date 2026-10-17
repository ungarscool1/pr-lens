import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ReviewDecision } from '../../../../shared/ipc';
import { Blueprint } from '../../ds';

interface Props {
  event: ReviewDecision;
  stagedCount: number;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}

const FOCUSABLE = 'button:not(:disabled), textarea, input, [href], [tabindex]:not([tabindex="-1"])';

const DETAILS: Record<ReviewDecision, { title: string; action: string; required: boolean }> = {
  APPROVE: { title: 'Approve pull request?', action: 'Approve', required: false },
  COMMENT: { title: 'Submit review comment?', action: 'Comment', required: true },
  REQUEST_CHANGES: { title: 'Request changes?', action: 'Request changes', required: true },
};

/** Explicit submit point for the entire GitHub pending review, never for private notes. */
export function ReviewSubmitDialog({ event, stagedCount, busy, error, onCancel, onSubmit }: Props) {
  const [body, setBody] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const details = DETAILS[event];

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    textRef.current?.focus();
    return () => before?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !busy) {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };

  return (
    <div className="dialog-backdrop review-submit-backdrop" onKeyDown={onKeyDown}>
      <div ref={ref}>
        <Blueprint
          className="dialog review-submit-dialog"
          role="dialog"
          aria-modal
          aria-labelledby="review-submit-title"
        >
          <div className="dialog-title" id="review-submit-title">
            {details.title}
          </div>
          <div className="field">
            <label htmlFor="review-submit-body">
              General comment {details.required ? '(required)' : '(optional)'}
            </label>
            <textarea
              id="review-submit-body"
              ref={textRef}
              className="input"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={busy}
              placeholder={
                event === 'REQUEST_CHANGES'
                  ? 'Explain what needs to change'
                  : 'Leave an overall comment'
              }
            />
          </div>
          <p className="promote-help">
            {stagedCount
              ? `${stagedCount} staged GitHub comment${stagedCount === 1 ? '' : 's'} will be published with this review.`
              : 'No staged line comments will be added to this review.'}{' '}
            Private notes stay in PR Lens and are not sent.
          </p>
          {error && (
            <p className="promote-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => onSubmit(body)}
              disabled={busy || (details.required && !body.trim())}
            >
              {busy ? 'Submitting…' : details.action}
            </button>
          </div>
        </Blueprint>
      </div>
    </div>
  );
}
