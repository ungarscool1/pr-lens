import { useCallback, useEffect, useState } from 'react';
import type { Health } from '../../shared/health';
import { parsePrInput } from '../../shared/pr';
import type { SettingsView } from '../../shared/settings';
import { ComparePage } from './features/compare/ComparePage';
import { ReviewPage } from './features/review/ReviewPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { Header } from './features/shell/Header';
import { api, errorMessage, run } from './lib/api';

export type View = 'review' | 'compare' | 'settings';

export function App() {
  const [view, setView] = useState<View>('review');
  // Compare mounts on first visit (it may query refs) and then stays mounted, like the review.
  const [compareOpened, setCompareOpened] = useState(false);
  const [prInput, setPrInput] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const recheck = useCallback(async () => {
    try {
      setHealth(await run(api.health.check()));
    } catch (e) {
      setBootError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    run(api.settings.get()).then(setSettings, (e: unknown) => setBootError(errorMessage(e)));
    run(api.health.check()).then(setHealth, (e: unknown) => setBootError(errorMessage(e)));
  }, []);

  const current = prInput ? parsePrInput(prInput) : null;
  const toolsReady = health ? health.gh.authenticated && health.claude.loggedIn : true;

  return (
    <div className="app">
      <Header
        current={current}
        view={view}
        health={health}
        onOpen={(input) => {
          setPrInput(input);
          setView('review');
        }}
        onShowReview={() => setView('review')}
        onShowCompare={() => {
          setCompareOpened(true);
          setView('compare');
        }}
        onShowSettings={() => setView('settings')}
      />
      <div className="app-body">
        {bootError && (
          <p className="boot-error" role="alert">
            {bootError}
          </p>
        )}
        {view === 'settings' && settings && (
          <SettingsPage
            settings={settings}
            health={health}
            onSettings={setSettings}
            onRecheck={recheck}
          />
        )}
        {/* Kept mounted while Settings is open, so scroll position and review state survive. */}
        {prInput && settings && (
          <div className="view" hidden={view !== 'review'}>
            <ReviewPage
              key={prInput}
              source={{ kind: 'pr', input: prInput }}
              active={view === 'review'}
              autoRunMaxTokens={settings.autoRunMaxTokens}
            />
          </div>
        )}
        {compareOpened && settings && (
          <div className="view" hidden={view !== 'compare'}>
            <ComparePage
              defaultRepo={current ? { owner: current.owner, repo: current.repo } : null}
              active={view === 'compare'}
              autoRunMaxTokens={settings.autoRunMaxTokens}
            />
          </div>
        )}
        {view === 'review' && !prInput && (
          <main className="page-msg">
            <h1>Open a pull request</h1>
            <p>Paste a PR link or owner/repo#123 in the field above and press Enter.</p>
            {!toolsReady && (
              <p>
                Some tools are not ready.{' '}
                <button className="link" onClick={() => setView('settings')}>
                  Open the health check
                </button>
                .
              </p>
            )}
          </main>
        )}
      </div>
    </div>
  );
}
