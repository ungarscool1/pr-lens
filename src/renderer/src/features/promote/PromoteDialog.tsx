import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { PromotePreview } from '../../../../shared/ipc';
import { Blueprint } from '../../ds';
import './promote.css';

interface Props {
  preview: PromotePreview;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (body: string) => void;
}

const FOCUSABLE = 'button:not(:disabled), textarea, input, [href], [tabindex]:not([tabindex="-1"])';

/** Explicit confirmation before anything is written to GitHub. Keeps focus inside while open. */
export function PromoteDialog({ preview: p, busy, error, onCancel, onConfirm }: Props) {
  const [body, setBody] = useState(p.body);
  const ref = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

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

  const where = p.fileLevel
    ? `${p.path} · whole file`
    : `${p.path}:${p.startLine === p.endLine ? p.startLine : `${p.startLine}–${p.endLine}`} · ${p.side}`;

  return (
    <div className="dialog-backdrop promote-backdrop" onKeyDown={onKeyDown}>
      <div ref={ref}>
        <Blueprint
          className="dialog promote-dialog"
          role="dialog"
          aria-modal
          aria-labelledby="promote-title"
        >
          <div className="dialog-title" id="promote-title">
            Add to your pending review?
          </div>
          <dl className="promote-facts">
            <dt>PR</dt>
            <dd>
              {p.pr} · head {p.headSha.slice(0, 7)}
            </dd>
            <dt>Line</dt>
            <dd>{where}</dd>
            <dt>Account</dt>
            <dd>via gh · {p.viewer}</dd>
            <dt>Review</dt>
            <dd>
              {p.pendingReviewExists ? 'your existing pending review' : 'a new pending review'}
            </dd>
          </dl>
          <div className="field">
            <label htmlFor="promote-body">Comment body (markdown)</label>
            <textarea
              id="promote-body"
              ref={textRef}
              className="input"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={busy}
            />
          </div>
          <p className="promote-help">
            The comment goes into your pending review. Nobody else sees it until you submit the
            review on GitHub.
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
              onClick={() => onConfirm(body)}
              disabled={busy || !body.trim()}
            >
              {busy ? 'Adding…' : 'Add to pending review'}
            </button>
          </div>
        </Blueprint>
      </div>
    </div>
  );
}
