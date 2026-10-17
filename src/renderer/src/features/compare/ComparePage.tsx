import { useEffect, useId, useMemo, useState } from 'react';
import { DIFF_MODE_LABELS, GitRefName, parseRepo } from '../../../../shared/subject';
import type { DiffMode, RefSuggestion, RepoRef } from '../../../../shared/subject';
import { Seg } from '../../ds';
import { api, run } from '../../lib/api';
import { ReviewPage } from '../review/ReviewPage';
import type { Source } from '../review/useReview';

const SUGGEST_DELAY_MS = 250;

/** A ref field with branch/tag suggestions from gh, fetched as you type (debounced). */
function RefField({
  label,
  repo,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  repo: RepoRef | null;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const id = useId();
  const [refs, setRefs] = useState<RefSuggestion[]>([]);
  useEffect(() => {
    if (!repo) return;
    const query = value.trim();
    if (!/^[A-Za-z0-9._/+@-]*$/.test(query)) return;
    let live = true;
    const t = setTimeout(() => {
      run(api.github.searchRefs({ ...repo, query }))
        .then((r) => {
          if (live) setRefs(r.refs);
        })
        // Suggestions are a convenience; a failed lookup just shows none.
        .catch(() => {
          if (live) setRefs([]);
        });
    }, SUGGEST_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [repo, value]);

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input mono"
        list={`${id}-refs`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
      />
      <datalist id={`${id}-refs`}>
        {refs.map((r) => (
          <option key={`${r.kind}:${r.name}`} value={r.name}>
            {r.kind}
          </option>
        ))}
      </datalist>
    </div>
  );
}

export function ComparePage({
  defaultRepo,
  active,
  autoRunMaxTokens,
  promoteEnabled,
}: {
  defaultRepo: RepoRef | null;
  active: boolean;
  autoRunMaxTokens: number;
  promoteEnabled: boolean;
}) {
  const [repoText, setRepoText] = useState(
    defaultRepo ? `${defaultRepo.owner}/${defaultRepo.repo}` : '',
  );
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [mode, setMode] = useState<DiffMode>('three-dot');
  const [source, setSource] = useState<Extract<Source, { kind: 'compare' }> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // One object per repo, so the suggestion effects do not refire on unrelated keystrokes.
  const repoId = repoText.trim();
  const repo = useMemo(() => parseRepo(repoId), [repoId]);

  const submit = (): void => {
    if (!repo) return setProblem('Repository must be owner/repo.');
    if (!GitRefName.safeParse(base).success || !GitRefName.safeParse(head).success) {
      return setProblem('Base and head must be a branch, tag or commit SHA.');
    }
    setProblem(null);
    setSource({ kind: 'compare', ...repo, base: base.trim(), head: head.trim(), mode });
  };

  return (
    <div className="compare">
      <form
        className="compare-form"
        aria-label="Compare refs"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="field">
          <label htmlFor="compare-repo">Repository</label>
          <input
            id="compare-repo"
            className="input mono"
            value={repoText}
            onChange={(e) => setRepoText(e.target.value)}
            placeholder="owner/repo"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <RefField
          label="Base"
          repo={repo}
          value={base}
          onChange={setBase}
          placeholder="v1.4.0, main or a SHA"
        />
        <RefField
          label="Head"
          repo={repo}
          value={head}
          onChange={setHead}
          placeholder="v1.5.0 or a branch"
        />
        <div className="field">
          <span className="field-label">Diff</span>
          <Seg<DiffMode>
            name="compare-form-mode"
            label="Diff mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'three-dot', label: DIFF_MODE_LABELS['three-dot'] },
              { value: 'two-dot', label: DIFF_MODE_LABELS['two-dot'] },
            ]}
          />
        </div>
        <button className="btn btn-primary" type="submit">
          Compare
        </button>
        {problem && (
          <p className="compare-problem" role="alert">
            {problem}
          </p>
        )}
      </form>
      {source ? (
        <ReviewPage
          key={`${source.owner}/${source.repo}:${source.base}:${source.head}:${source.mode}`}
          source={source}
          active={active}
          autoRunMaxTokens={autoRunMaxTokens}
          promoteEnabled={promoteEnabled}
          onMode={(m) => {
            setMode(m);
            setSource({ ...source, mode: m });
          }}
        />
      ) : (
        <main className="page-msg">
          <h1>Compare two refs</h1>
          <p>
            Pick a base and a head: branches, tags or SHAs. Merge base (three-dot) shows what head
            adds, like GitHub. Direct (two-dot) diffs the two trees. Two tags also get an optional
            release summary.
          </p>
        </main>
      )}
    </div>
  );
}
