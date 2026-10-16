import type { DiffFile } from '../../../../shared/diff';
import { noiseKind } from '../../../../shared/diff';
import type { NoteState } from '../../../../shared/notes';
import type { Analysis, Estimate, FileRisk } from '../../../../shared/review';
import { SevTag } from '../../ds';
import type { Job } from './useReview';
import type { ViewNote } from './model';

const k = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

interface Props {
  files: DiffFile[];
  orderedFiles: DiffFile[];
  risks: Map<string, FileRisk>;
  notes: ViewNote[];
  noteState: Readonly<Record<string, NoteState>>;
  analysis: Analysis | null;
  estimate: Estimate;
  headSha: string;
  job: Job | null;
  onJumpFile: (fid: string) => void;
  onJumpNote: (n: ViewNote) => void;
  onRerun: () => void;
}

export function Sidebar(p: Props) {
  const noise = p.files.filter((f) => f.noise !== null);
  const open = p.notes.filter(
    (n) => !p.noteState[n.id]?.dismissed && !p.noteState[n.id]?.seen,
  ).length;
  let rank = 0;

  return (
    <aside className="sidebar" aria-label="Review navigation">
      <div className="sidebar-head">
        <h2 className="sidebar-title">Reading order</h2>
        <span className="sidebar-meta">{p.analysis ? 'AI order' : 'path order'}</span>
      </div>
      <ol className="sidebar-list">
        {p.orderedFiles.map((f, i) => {
          const risk = p.risks.get(f.fid);
          const ai = p.notes.filter((n) => n.fid === f.fid && n.source === 'ai').length;
          const me = p.notes.filter((n) => n.fid === f.fid && n.source === 'me').length;
          return (
            <li key={f.fid}>
              <button className="side-item" onClick={() => p.onJumpFile(f.fid)}>
                <span className="side-ord">{i + 1}</span>
                <span className="side-body">
                  <span className="side-name" title={f.path}>
                    {baseName(f.path)}
                  </span>
                  {risk?.why && <span className="side-why">{risk.why}</span>}
                  <span className="side-sub">
                    +{f.additions} −{f.deletions}
                    {p.analysis ? ` · ${ai} AI` : ''}
                    {me ? ` · ${me} mine` : ''}
                  </span>
                </span>
                {risk && risk.risk !== 'none' ? (
                  <SevTag kind={risk.risk}>{risk.risk}</SevTag>
                ) : (
                  <span />
                )}
              </button>
            </li>
          );
        })}
        {noise.map((f) => (
          <li key={f.fid} className="side-item static">
            <span className="side-ord">—</span>
            <span className="side-body">
              <span className="side-name struck">{baseName(f.path)}</span>
              <span className="side-why">
                {capitalize(noiseKind(f.noise ?? ''))} · hidden, not reviewed
              </span>
            </span>
            <span className="side-sub">
              +{f.additions} −{f.deletions}
            </span>
          </li>
        ))}
      </ol>

      <div className="sidebar-head ruled">
        <h2 className="sidebar-title">Attention points</h2>
        <span className="sidebar-meta">{open} open</span>
      </div>
      <ol className="sidebar-list">
        {p.notes.map((n) => {
          const st = p.noteState[n.id] ?? {};
          const sev = n.source === 'ai' ? n.severity : 'mine';
          return (
            <li key={n.id}>
              <button
                className={`side-item note ${st.seen || st.dismissed ? 'dim' : ''}`}
                onClick={() => p.onJumpNote(n)}
              >
                <span className="side-ord">{n.source === 'ai' ? ++rank : '·'}</span>
                <span className="side-body">
                  <span className={`side-note-title ${st.dismissed ? 'struck' : ''}`}>
                    {n.source === 'ai' ? n.title : n.body}
                  </span>
                  <span className="side-sub">
                    <span className={`sev-dot sev-${sev}`} aria-hidden="true" />
                    {baseName(n.path)}
                    {n.source === 'ai' && n.fileLevel ? '' : `:${n.startLine}`}
                    {n.source === 'me' ? ' · private' : ''}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {!p.notes.length && (
          <li className="side-item static note">
            <span />
            <span className="side-why">{p.analysis ? 'Nothing flagged.' : 'No notes yet.'}</span>
          </li>
        )}
      </ol>

      <dl className="shortcuts" aria-label="Keyboard shortcuts">
        <dt>j / k</dt>
        <dd>next / previous note</dd>
        <dt>s</dt>
        <dd>mark seen</dd>
        <dt>d</dt>
        <dd>dismiss</dd>
        <dt>↑ ↓ ⏎</dt>
        <dd>move in diff / add note</dd>
      </dl>

      <div className="analysis">
        <span className="card-kicker">Analysis · {p.analysis?.promptVersion ?? 'review.v1'}</span>
        <dl>
          <dt>head</dt>
          <dd>
            {p.headSha.slice(0, 7)}
            {p.analysis ? ' · this session' : ''}
          </dd>
          {p.analysis && (
            <>
              <dt>usage</dt>
              <dd>
                {k(p.analysis.usage.inputTokens)} in · {k(p.analysis.usage.outputTokens)} out
              </dd>
              <dt>chunks</dt>
              <dd>
                {p.analysis.chunks} · {MERGE_LABEL[p.analysis.merge]}
                {p.analysis.failedChunks ? ` · ${p.analysis.failedChunks} failed` : ''}
              </dd>
              <dt>dropped</dt>
              <dd>
                {p.analysis.dropped.length}
                {p.analysis.dropped[0] ? ` · ${p.analysis.dropped[0].reason}` : ''}
              </dd>
            </>
          )}
        </dl>
        {p.analysis && p.analysis.failedChunks > 0 && (
          <p className="analysis-warn">
            Partial review: {p.analysis.failedChunks} of {p.analysis.chunks} chunks failed, so some
            files have no AI notes. Re-run to try again.
          </p>
        )}
        {p.analysis && p.analysis.dropped.length > 0 && (
          <details className="dropped">
            <summary>Dropped notes</summary>
            <ul>
              {p.analysis.dropped.map((d, i) => (
                <li key={`${d.key}-${i}`}>
                  <b>{d.key}</b> {d.title} <span>· {d.reason}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {p.estimate.secrets.length > 0 && (
          <p className="analysis-warn">
            {p.estimate.secrets.length} likely secret{p.estimate.secrets.length > 1 ? 's' : ''} (
            {[...new Set(p.estimate.secrets.map((s) => s.kind))].join(', ')}) will be masked before
            sending.
          </p>
        )}
        <button
          className="btn btn-secondary"
          onClick={p.onRerun}
          disabled={p.job !== null || p.estimate.blocked !== null}
          title={p.estimate.blocked ?? undefined}
        >
          {p.analysis ? 'Re-run review' : 'Run review'}
          <span className="btn-hint">
            {p.estimate.blocked
              ? 'too large'
              : `~${k(p.estimate.inputTokens)} tokens${p.estimate.chunks > 1 ? ` · ${p.estimate.chunks} chunks` : ''}`}
          </span>
        </button>
      </div>
    </aside>
  );
}

const MERGE_LABEL = {
  none: 'no merge pass',
  model: 'merge pass',
  fallback: 'merged by rules',
} as const;

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
