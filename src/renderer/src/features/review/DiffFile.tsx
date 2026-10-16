import { memo, useMemo, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { DiffFile as DiffFileModel, Side } from '../../../../shared/diff';
import type { NoteState } from '../../../../shared/notes';
import type { FileRisk } from '../../../../shared/review';
import { Icon, SevTag } from '../../ds';
import type { Tok } from '../../lib/highlight';
import { buildRows, highlightedLines } from './model';
import type { Cell, ComposerAt, Row, ViewMode, ViewNote } from './model';
import { Composer, NoteRow } from './NoteView';
import type { RefTarget } from './NoteView';

export const fileDomId = (fid: string): string => `file-${fid}`;
export const lineDomId = (lineId: string): string => `L-${lineId}`;

interface Props {
  file: DiffFileModel;
  risk: FileRisk | undefined;
  notes: ViewNote[];
  noteState: Readonly<Record<string, NoteState>>;
  mode: ViewMode;
  open: boolean;
  viewed: boolean;
  currentNoteId: string | null;
  composer: ComposerAt | null;
  onToggleOpen: () => void;
  onToggleViewed: () => void;
  onCompose: (at: ComposerAt | null) => void;
  onSaveNote: (at: ComposerAt, body: string) => Promise<boolean>;
  onPatchNote: (id: string, patch: NoteState) => void;
  onDeleteNote: (id: string) => void;
  resolveRef: (id: string) => RefTarget | null;
  onJumpRef: (domId: string) => void;
  onAskNote: (id: string) => void;
  askingNoteId: string | null;
  onPromoteNote: (id: string) => void;
  promoteBlocked: string | null;
}

const MARK = { add: '+', del: '−', ctx: '' } as const;

function Code({ toks }: { toks: Tok[] }) {
  return (
    <>
      {toks.map((t, i) => (
        <span key={i} className={`t-${t.k}${t.changed ? ' t-changed' : ''}`}>
          {t.s}
        </span>
      ))}
    </>
  );
}

const kindClass = (c: Cell | null): string =>
  !c ? 'c-empty' : c.line.kind === 'ctx' ? '' : `c-${c.line.kind}`;

/** Row anchors for keyboard navigation: one per line row (the right side wins in split view). */
const anchorOf = (r: Row): ComposerAt | null => {
  const c = r.kind === 'line' ? r.cell : r.kind === 'pair' ? (r.right ?? r.left) : null;
  return c ? { fid: '', side: c.side, line: c.num, lineId: c.line.id } : null;
};

function DiffFileView(p: Props) {
  const { file } = p;
  const [active, setActive] = useState<number | null>(null);
  const rows = useMemo(
    () => (p.open ? buildRows(file, p.notes, p.mode, p.composer) : []),
    [file, p.notes, p.mode, p.composer, p.open],
  );
  const hl = useMemo(() => highlightedLines(p.notes, p.noteState), [p.notes, p.noteState]);
  const lineRows = useMemo(
    () => rows.map((r, i) => [i, anchorOf(r)] as const).filter(([, a]) => a),
    [rows],
  );

  const compose = (side: Side, num: number, lineId: string): void =>
    p.onCompose({ fid: file.fid, side, line: num, lineId });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget || !lineRows.length) return;
    const pos = lineRows.findIndex(([i]) => i === active);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next =
        e.key === 'ArrowDown' ? Math.min(pos + 1, lineRows.length - 1) : Math.max(pos - 1, 0);
      const idx = lineRows[pos < 0 ? 0 : next]?.[0] ?? null;
      setActive(idx);
      if (idx !== null)
        document.getElementById(`row-${file.fid}-${idx}`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && active !== null) {
      e.preventDefault();
      const a = anchorOf(rows[active] as Row);
      if (a) compose(a.side, a.line, a.lineId);
    }
  };

  const numCell = (
    c: Cell | null,
    which: 'o' | 'n' | 'l' | 'r',
    addTo: Cell | null = null,
  ): ReactNode => {
    const value = !c ? '' : which === 'o' ? c.line.old : which === 'n' ? c.line.new : c.num;
    // Unified rows highlight both gutters when either side is anchored; split cells use their own side.
    const unified = which === 'o' || which === 'n';
    const hit = !c
      ? false
      : unified
        ? (c.line.kind === 'del' && hl.LEFT.has(c.line.old ?? -1)) || hl.RIGHT.has(c.line.new ?? -1)
        : hl[c.side].has(c.num);
    return (
      <span className={`num ${which === 'r' ? 'r' : ''} ${hit ? 'hl' : kindClass(c)}`}>
        {value ?? ''}
        {addTo && (
          <button
            className="add-note"
            tabIndex={-1}
            title="Add a private note"
            aria-label={`Add a private note on line ${addTo.num}`}
            onClick={() => compose(addTo.side, addTo.num, addTo.line.id)}
          >
            <span aria-hidden="true">+</span>
          </button>
        )}
      </span>
    );
  };

  const renderRow = (r: Row, i: number): ReactNode => {
    const isActive = i === active;
    switch (r.kind) {
      case 'hunk':
        return (
          <div key={r.key} className="hunk">
            <span className="hunk-expand" title="Expanding context arrives after the MVP">
              <Icon name="expand" />
            </span>
            <span className="hunk-text">{r.header}</span>
          </div>
        );
      case 'line': {
        const c = r.cell;
        return (
          <div
            key={r.key}
            id={`row-${file.fid}-${i}`}
            className={`dl ${kindClass(c)} ${isActive ? 'active' : ''}`}
          >
            {numCell(c, 'o')}
            {numCell(c, 'n', c)}
            <span className={`mark ${kindClass(c)}`}>{MARK[c.line.kind]}</span>
            <span className="code" id={lineDomId(c.line.id)}>
              <Code toks={c.toks} />
            </span>
          </div>
        );
      }
      case 'pair':
        return (
          <div
            key={r.key}
            id={`row-${file.fid}-${i}`}
            className={`dl pair ${isActive ? 'active' : ''}`}
          >
            {numCell(r.left, 'l')}
            <span className={`mark ${kindClass(r.left)}`}>
              {r.left ? MARK[r.left.line.kind] : ''}
            </span>
            <span
              className={`code ${kindClass(r.left)}`}
              id={r.left && r.left.line.kind === 'del' ? lineDomId(r.left.line.id) : undefined}
            >
              {r.left && <Code toks={r.left.toks} />}
            </span>
            {numCell(r.right, 'r', r.right ?? r.left)}
            <span className={`mark ${kindClass(r.right)}`}>
              {r.right ? MARK[r.right.line.kind] : ''}
            </span>
            <span
              className={`code ${kindClass(r.right)}`}
              id={r.right ? lineDomId(r.right.line.id) : undefined}
            >
              {r.right && <Code toks={r.right.toks} />}
            </span>
          </div>
        );
      case 'note':
        return (
          <NoteRow
            key={r.key}
            note={r.note}
            state={p.noteState[r.note.id] ?? {}}
            current={p.currentNoteId === r.note.id}
            resolveRef={p.resolveRef}
            onJumpRef={p.onJumpRef}
            onPatch={(patch) => p.onPatchNote(r.note.id, patch)}
            onDelete={() => p.onDeleteNote(r.note.id)}
            onAsk={() => p.onAskNote(r.note.id)}
            asking={p.askingNoteId === r.note.id}
            onPromote={() => p.onPromoteNote(r.note.id)}
            promoteBlocked={p.promoteBlocked}
          />
        );
      case 'composer': {
        const at = p.composer as ComposerAt;
        return (
          <Composer
            key={r.key}
            location={`${file.path}:${at.line} · ${at.lineId}`}
            onCancel={() => p.onCompose(null)}
            onSave={async (body) => {
              const ok = await p.onSaveNote(at, body);
              if (ok) p.onCompose(null);
              return ok;
            }}
          />
        );
      }
    }
  };

  const slash = file.path.lastIndexOf('/');
  const total = file.additions + file.deletions;
  const addBlocks = total ? Math.round((5 * file.additions) / total) : 0;
  const titleId = `${fileDomId(file.fid)}-title`;

  return (
    <section className="file" id={fileDomId(file.fid)} aria-labelledby={titleId}>
      <div className="file-head">
        <button
          className="btn btn-ghost file-toggle"
          aria-expanded={p.open}
          aria-controls={`${fileDomId(file.fid)}-diff`}
          aria-label={p.open ? 'Collapse file' : 'Expand file'}
          onClick={p.onToggleOpen}
        >
          <Icon name="chevronDown" size={16} />
        </button>
        <h3 className="file-path" id={titleId}>
          <span>{file.path.slice(0, slash + 1)}</span>
          <b>{file.path.slice(slash + 1)}</b>
        </h3>
        <span className="counts">
          <span className="add">+{file.additions}</span>{' '}
          <span className="del">−{file.deletions}</span>
        </span>
        <span className="blocks" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={i < addBlocks ? 'add' : file.deletions ? 'del' : ''} />
          ))}
        </span>
        <span className="tag tag-neutral file-status">{file.binary ? 'binary' : file.status}</span>
        {p.risk && p.risk.risk !== 'none' && <SevTag kind={p.risk.risk}>{p.risk.risk} risk</SevTag>}
        <label className="viewed-check">
          <input type="checkbox" checked={p.viewed} onChange={p.onToggleViewed} />
          Viewed
        </label>
      </div>
      {p.open && (
        <div
          id={`${fileDomId(file.fid)}-diff`}
          className={`diff ${p.mode === 'split' ? 'split' : ''}`}
          tabIndex={0}
          role="group"
          aria-label={`Diff of ${file.path}. Arrow keys move between lines, Enter adds a private note.`}
          onKeyDown={onKeyDown}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setActive(null);
          }}
        >
          {file.binary && (
            <div className="hunk">
              <span />
              <span className="hunk-text">Binary file not shown</span>
            </div>
          )}
          {!file.binary && !file.hunks.length && (
            <div className="hunk">
              <span />
              <span className="hunk-text">
                {file.status === 'renamed'
                  ? `Renamed from ${file.oldPath ?? ''}, no content changes`
                  : 'No content changes'}
              </span>
            </div>
          )}
          {rows.map(renderRow)}
        </div>
      )}
    </section>
  );
}

export const DiffFile = memo(DiffFileView);
