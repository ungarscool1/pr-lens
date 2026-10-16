import { useState } from 'react';
import type { Health } from '../../../../shared/health';
import { parsePrInput } from '../../../../shared/pr';
import type { PrRef } from '../../../../shared/pr';
import type { View } from '../../App';
import { Blueprint, Icon } from '../../ds';
import './header.css';

interface Props {
  current: PrRef | null;
  view: View;
  health: Health | null;
  onOpen: (input: string) => void;
  onShowReview: () => void;
  onShowCompare: () => void;
  onShowSettings: () => void;
}

function healthLabel(h: Health | null): {
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
    gh: ghOk ? 'gh · read-only' : h.gh.path ? 'gh · not logged in' : 'gh · not found',
    claudeOk,
    ghOk,
  };
}

export function Header({
  current,
  view,
  health,
  onOpen,
  onShowReview,
  onShowCompare,
  onShowSettings,
}: Props) {
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const hl = healthLabel(health);

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
      <span className="brand">
        <Blueprint className="brand-mark" corners={['tl', 'br']}>
          <span />
        </Blueprint>
        <span className="brand-name">PR Lens</span>
      </span>
      <nav className="tabs" aria-label="Views">
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
        className="status"
        onClick={onShowSettings}
        aria-label="Tool status. Open settings"
        aria-current={view === 'settings' ? 'page' : undefined}
      >
        <span className="status-item">
          <span className={`status-dot ${hl.claudeOk ? 'ok' : ''}`} aria-hidden="true" />
          {hl.claude}
        </span>
        <span className="status-item">
          <span className={`status-dot ${hl.ghOk ? 'ok' : ''}`} aria-hidden="true" />
          {hl.gh}
        </span>
      </button>
    </header>
  );
}
