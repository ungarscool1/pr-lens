import { useState } from 'react';
import type { Health } from '../../../../shared/health';
import { parsePrInput } from '../../../../shared/pr';
import type { PrRef } from '../../../../shared/pr';
import type { View } from '../../App';
import { Blueprint, Icon } from '../../ds';

interface Props {
  current: PrRef | null;
  view: View;
  health: Health | null;
  /** Promote to comment is turned on. */
  canComment: boolean;
  onOpen: (input: string) => void;
  onShowInbox: () => void;
  onShowReview: () => void;
  onShowCompare: () => void;
  onShowSettings: () => void;
}

function healthLabel(
  h: Health | null,
  canComment: boolean,
): {
  claude: string;
  gh: string;
  claudeOk: boolean;
  ghOk: boolean;
} {
  if (!h) return { claude: 'claude · checking', gh: 'gh · checking', claudeOk: false, ghOk: false };
  const claudeOk = h.claude.loggedIn;
  const ghOk = h.gh.authenticated;
  const how =
    h.claude.authMethod === 'claude.ai' ? 'subscription' : (h.claude.authMethod ?? 'logged in');
  return {
    claude: claudeOk
      ? `claude · ${how}`
      : h.claude.path
        ? 'claude · not logged in'
        : 'claude · not found',
    gh: ghOk
      ? canComment
        ? 'gh · can comment'
        : 'gh · read-only'
      : h.gh.path
        ? 'gh · not logged in'
        : 'gh · not found',
    claudeOk,
    ghOk,
  };
}

export function Header({
  current,
  view,
  health,
  canComment,
  onOpen,
  onShowInbox,
  onShowReview,
  onShowCompare,
  onShowSettings,
}: Props) {
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const hl = healthLabel(health, canComment);

  const submit = (): void => {
    if (!parsePrInput(value)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onOpen(value.trim());
  };

  return (
    <header className="app-header">
      <button className="brand brand-home" onClick={onShowInbox} aria-label="PR Lens home: Inbox">
        <Blueprint className="brand-mark" corners={['tl', 'br']}>
          <span />
        </Blueprint>
        <span className="brand-name">PR Lens</span>
      </button>
      <nav className="tabs" aria-label="Views">
        <button
          className="tab"
          aria-current={view === 'inbox' ? 'page' : undefined}
          onClick={onShowInbox}
        >
          Inbox
        </button>
        {current && (
          <button
            className="tab"
            aria-current={view === 'review' ? 'page' : undefined}
            onClick={onShowReview}
          >
            #{current.number}
          </button>
        )}
        <button
          className="tab"
          aria-current={view === 'compare' ? 'page' : undefined}
          onClick={onShowCompare}
        >
          Compare
        </button>
      </nav>
      <form
        className={`pr-input ${invalid ? 'invalid' : ''}`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Icon name="branch" size={15} style={{ flex: 'none' }} />
        <label htmlFor="pr-input" className="visually-hidden">
          Pull request URL or owner/repo#number
        </label>
        <input
          id="pr-input"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setInvalid(false);
          }}
          placeholder={
            current
              ? `github.com/${current.owner}/${current.repo}/pull/${current.number}`
              : 'github.com/owner/repo/pull/123 or owner/repo#123'
          }
          aria-invalid={invalid}
          aria-describedby={invalid ? 'pr-input-error' : undefined}
          spellCheck={false}
          autoComplete="off"
        />
        {invalid && (
          <span id="pr-input-error" className="pr-input-error">
            Not a PR link
          </span>
        )}
      </form>
      <button
        className="settings-trigger"
        onClick={onShowSettings}
        aria-label={`Settings. ${hl.claude}. ${hl.gh}.`}
        aria-current={view === 'settings' ? 'page' : undefined}
      >
        <Icon name="settings" />
        <span>Settings</span>
        <span className="settings-health" aria-hidden="true">
          <span className={`status-dot ${hl.claudeOk ? 'ok' : ''}`} />
          <span className={`status-dot ${hl.ghOk ? 'ok' : ''}`} />
        </span>
      </button>
    </header>
  );
}
