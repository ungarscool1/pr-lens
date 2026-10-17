import { useMemo, useState, type ReactNode } from 'react';
import type { DiffFile } from '../../../../shared/diff';
import { noiseKind } from '../../../../shared/diff';
import type { NoteState } from '../../../../shared/notes';
import type { Analysis, CacheInfo, Estimate, FileRisk } from '../../../../shared/review';
import { ago } from '../../lib/time';
import { Icon, SevTag } from '../../ds';
import type { Job } from './useReview';
import type { ViewNote } from './model';

const k = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

interface FileTree {
  count: number;
  folders: Map<string, FileTree>;
  files: DiffFile[];
}

const toFileTree = (files: DiffFile[]): FileTree => {
  const root: FileTree = { count: 0, folders: new Map(), files: [] };

  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    const name = parts.pop();
    let node = root;
    node.count += 1;
    for (const part of parts) {
      let child = node.folders.get(part);
      if (!child) {
        child = { count: 0, folders: new Map(), files: [] };
        node.folders.set(part, child);
      }
      node = child;
      node.count += 1;
    }
    if (name) node.files.push(file);
  }

  return root;
};

interface Props {
  files: DiffFile[];
  orderedFiles: DiffFile[];
  risks: Map<string, FileRisk>;
  notes: ViewNote[];
  noteState: Readonly<Record<string, NoteState>>;
  analysis: Analysis | null;
  cache: CacheInfo | null;
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
  const fileTree = useMemo(() => toFileTree(p.orderedFiles), [p.orderedFiles]);
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
  const fileRanks = useMemo(
    () => new Map(p.orderedFiles.map((file, index) => [file.fid, index + 1])),
    [p.orderedFiles],
  );
  let rank = 0;

  const renderFile = (file: DiffFile, depth: number): ReactNode => {
    const risk = p.risks.get(file.fid);
    const ai = p.notes.filter((n) => n.fid === file.fid && n.source === 'ai').length;
    const me = p.notes.filter((n) => n.fid === file.fid && n.source === 'me').length;
    return (
      <li key={file.fid} className="side-tree-file" style={{ paddingLeft: depth * 8 }}>
        <button className="side-item" onClick={() => p.onJumpFile(file.fid)}>
          <span className="side-ord">{fileRanks.get(file.fid)}</span>
          <span className="side-body">
            <span className="side-name" title={file.path}>
              {baseName(file.path)}
            </span>
            {risk?.why && <span className="side-why">{risk.why}</span>}
            <span className="side-sub">
              +{file.additions} −{file.deletions}
              {p.analysis ? ` · ${ai} AI` : ''}
              {me ? ` · ${me} mine` : ''}
            </span>
          </span>
          {risk && risk.risk !== 'none' ? <SevTag kind={risk.risk}>{risk.risk}</SevTag> : <span />}
        </button>
      </li>
    );
  };

  const renderTree = (node: FileTree, parentPath: string, depth: number): ReactNode => (
    <>
      {[...node.folders].map(([name, folder]) => {
        const path = parentPath ? `${parentPath}/${name}` : name;
        const expanded = !collapsedFolders[path];
        return (
          <li key={path} className="side-folder" style={{ paddingLeft: depth * 8 }}>
            <button
              className="side-folder-toggle"
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${path}`}
              onClick={() => setCollapsedFolders((folders) => ({ ...folders, [path]: expanded }))}
            >
              <Icon name="chevronDown" size={14} />
              <span className="side-folder-name" title={path}>
                {name}
              </span>
              <span className="side-folder-count">{folder.count}</span>
            </button>
            {expanded && <ol className="sidebar-tree-children">{renderTree(folder, path, depth + 1)}</ol>}
          </li>
        );
      })}
      {node.files.map((file) => renderFile(file, depth))}
    </>
  );

  return (
    <aside className="sidebar" aria-label="Review navigation">
      <div className="sidebar-head">
        <h2 className="sidebar-title">Files</h2>
        <span className="sidebar-meta">{p.analysis ? 'AI priority' : 'path order'}</span>
      </div>
      <ol className="sidebar-list sidebar-tree">
        {renderTree(fileTree, '', 0)}
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
        <dt>a</dt>
        <dd>ask Claude</dd>
        <dt>↑ ↓ ⏎</dt>
        <dd>move in diff / add note</dd>
      </dl>

      <div className="analysis">
        <span className="card-kicker">Analysis · {p.analysis?.promptVersion ?? 'review.v1'}</span>
        <dl>
          <dt>head</dt>
          <dd>
            {p.headSha.slice(0, 7)}
            {p.analysis && p.cache ? ` · ${cacheLabel(p.cache, p.analysis.createdAt)}` : ''}
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

const cacheLabel = (c: CacheInfo, createdAt: number): string =>
  c.from === 'cache'
    ? `cached ${ago(createdAt)}${c.stale ? ', older settings' : ''}`
    : c.saved
      ? 'reviewed just now'
      : 'not saved';

const MERGE_LABEL = {
  none: 'no merge pass',
  model: 'merge pass',
  fallback: 'merged by rules',
} as const;

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
