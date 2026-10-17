import { useState } from 'react';
import type { BinHealth, Health } from '../../../../shared/health';
import type { SettingsPatch, SettingsView } from '../../../../shared/settings';
import { Blueprint } from '../../ds';
import { api, errorMessage, run } from '../../lib/api';

interface Props {
  settings: SettingsView;
  health: Health | null;
  onSettings: (s: SettingsView) => void;
  onRecheck: () => Promise<void>;
}

function Check({
  name,
  bin,
  ok,
  okText,
}: {
  name: string;
  bin: BinHealth;
  ok: boolean;
  okText: string;
}) {
  return (
    <div className="check">
      <span className={`status-dot ${ok ? 'ok' : ''}`} aria-hidden="true" />
      <div>
        <div className="check-title">
          {name} · {ok ? okText : bin.path ? 'found, not ready' : 'not found'}
        </div>
        <div className="check-meta">
          {bin.path ?? 'not on PATH or in the usual locations'}
          {bin.version ? ` · ${bin.version}` : ''}
        </div>
        {bin.problem && <div className="check-problem">{bin.problem}</div>}
      </div>
    </div>
  );
}

export function SettingsPage({ settings, health, onSettings, onRecheck }: Props) {
  const [ghPath, setGhPath] = useState(settings.ghPath ?? '');
  const [claudePath, setClaudePath] = useState(settings.claudePath ?? '');
  const [model, setModel] = useState(settings.model ?? '');
  const [globs, setGlobs] = useState(settings.noiseGlobs.join('\n'));
  const [autoRun, setAutoRun] = useState(String(settings.autoRunMaxTokens));
  const [maxNotes, setMaxNotes] = useState(String(settings.maxNotes));
  const [terminalApp, setTerminalApp] = useState(settings.terminalApp);
  const [token, setToken] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const save = async (): Promise<void> => {
    const patch: SettingsPatch = {
      ghPath: ghPath.trim() || null,
      claudePath: claudePath.trim() || null,
      model: model.trim() || null,
      noiseGlobs: globs
        .split('\n')
        .map((g) => g.trim())
        .filter(Boolean),
      autoRunMaxTokens: Number(autoRun),
      maxNotes: Number(maxNotes),
      terminalApp: terminalApp.trim(),
    };
    try {
      onSettings(await run(api.settings.update(patch)));
      setMessage('Saved. Noise rules apply to the next PR you open.');
      await recheck();
    } catch (e) {
      setMessage(errorMessage(e));
    }
  };
  const canComment = !!health?.gh.scopes.some((s) => s === 'repo' || s === 'public_repo');
  const togglePromote = async (on: boolean): Promise<void> => {
    try {
      onSettings(await run(api.settings.update({ promoteEnabled: on })));
      setMessage(
        on ? 'Promote to comment is on.' : 'Promote to comment is off. PR Lens is read-only again.',
      );
    } catch (e) {
      setMessage(errorMessage(e));
    }
  };
  const recheck = async (): Promise<void> => {
    setChecking(true);
    await onRecheck();
    setChecking(false);
  };
  const saveToken = async (value: string | null): Promise<void> => {
    try {
      onSettings(await run(api.settings.setOAuthToken({ token: value })));
      setToken('');
      setMessage(value ? 'Token stored, encrypted with the system keychain.' : 'Token removed.');
      await recheck();
    } catch (e) {
      setMessage(errorMessage(e));
    }
  };

  return (
    <main className="settings">
      <h1>Settings</h1>

      <Blueprint as="section" className="settings-card" aria-labelledby="health-h">
        <div className="settings-card-head">
          <h2 id="health-h">Health check</h2>
          <button className="btn btn-secondary" onClick={() => void recheck()} disabled={checking}>
            {checking ? 'Checking…' : 'Re-check'}
          </button>
        </div>
        {health ? (
          <div className="checks">
            <Check
              name="gh"
              bin={health.gh}
              ok={health.gh.authenticated}
              okText={`found + authenticated as ${health.gh.user ?? '?'}`}
            />
            <Check
              name="claude"
              bin={health.claude}
              ok={health.claude.loggedIn}
              okText={`found + logged in (${health.claude.authMethod ?? 'ok'})`}
            />
          </div>
        ) : (
          <p role="status">Checking…</p>
        )}
      </Blueprint>

      <section className="settings-grid" aria-label="Preferences">
        <div className="field">
          <label htmlFor="gh-path">gh path (empty = auto-detect)</label>
          <input
            id="gh-path"
            className="input mono"
            value={ghPath}
            onChange={(e) => setGhPath(e.target.value)}
            placeholder="/opt/homebrew/bin/gh"
          />
        </div>
        <div className="field">
          <label htmlFor="claude-path">claude path (empty = auto-detect)</label>
          <input
            id="claude-path"
            className="input mono"
            value={claudePath}
            onChange={(e) => setClaudePath(e.target.value)}
            placeholder="~/.local/bin/claude (absolute)"
          />
        </div>
      </section>

      <details className="settings-advanced">
        <summary>Review behavior and advanced preferences</summary>
        <section className="settings-grid settings-advanced-grid" aria-label="Advanced preferences">
          <div className="field">
            <label htmlFor="model">Model (empty = claude default)</label>
            <input
              id="model"
              className="input mono"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. opus"
            />
          </div>
          <div className="field">
            <label htmlFor="auto-run">
              Auto-run when a PR opens, up to N input tokens (0 = never)
            </label>
            <input
              id="auto-run"
              className="input mono"
              type="number"
              min={0}
              step={1000}
              value={autoRun}
              onChange={(e) => setAutoRun(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="max-notes">Max notes per PR (1–10)</label>
            <input
              id="max-notes"
              className="input mono"
              type="number"
              min={1}
              max={10}
              value={maxNotes}
              onChange={(e) => setMaxNotes(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="terminal-app">
              Terminal app for Ask Claude (macOS, must run .command files)
            </label>
            <input
              id="terminal-app"
              className="input mono"
              value={terminalApp}
              onChange={(e) => setTerminalApp(e.target.value)}
              placeholder="Terminal"
            />
          </div>
          <div className="field wide">
            <label htmlFor="globs">Noise globs: collapsed and not reviewed (one per line)</label>
            <textarea
              id="globs"
              className="input mono"
              rows={8}
              value={globs}
              onChange={(e) => setGlobs(e.target.value)}
            />
          </div>
          <div className="settings-actions">
            <button className="btn btn-primary" onClick={() => void save()}>
              Save settings
            </button>
          </div>
        </section>
      </details>

      <Blueprint as="section" className="settings-card" aria-labelledby="promote-h">
        <h2 id="promote-h">Promote to comment</h2>
        <p className="settings-help">
          Off by default. When on, a note can be added to <b>your pending review</b> on GitHub,
          through your gh login, after you confirm it in a dialog. Nothing is ever posted
          automatically, and nobody sees a pending review until you submit it on GitHub.
        </p>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.promoteEnabled}
            onChange={(e) => void togglePromote(e.target.checked)}
          />
          Allow PR Lens to add notes to my pending reviews
        </label>
        {health && (
          <p className="settings-help">
            {canComment
              ? `gh can comment: token scopes include ${health.gh.scopes.filter((s) => s === 'repo' || s === 'public_repo').join(', ')}.`
              : 'Your gh token has no repo scope, so GitHub will refuse comments. Run `gh auth refresh -s repo` in a terminal, then re-check.'}
          </p>
        )}
      </Blueprint>

      <Blueprint as="section" className="settings-card" aria-labelledby="token-h">
        <h2 id="token-h">Claude OAuth token (optional)</h2>
        <p className="settings-help">
          Leave empty to use your existing <code>claude</code> login. To use a long-lived token
          instead, run <code>claude setup-token</code> in a terminal and paste the result here. It
          is encrypted with the system keychain, passed only to the <code>claude</code> process, and
          never shown again.
        </p>
        <p className="settings-help">
          Status: <b>{settings.hasOAuthToken ? 'a token is stored' : 'no token stored'}</b>
        </p>
        <div className="token-row">
          <label htmlFor="token" className="visually-hidden">
            OAuth token
          </label>
          <input
            id="token"
            className="input mono"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste token"
          />
          <button
            className="btn btn-secondary"
            onClick={() => void saveToken(token.trim())}
            disabled={token.trim().length < 20}
          >
            Store
          </button>
          {settings.hasOAuthToken && (
            <button className="btn btn-ghost" onClick={() => void saveToken(null)}>
              Remove
            </button>
          )}
        </div>
      </Blueprint>

      {message && (
        <p className="settings-message" role="status">
          {message}
        </p>
      )}
    </main>
  );
}
