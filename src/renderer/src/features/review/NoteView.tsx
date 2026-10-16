import { useState } from 'react';
import type { NoteState } from '../../../../shared/notes';
import { CATEGORY_LABELS } from '../../../../shared/review';
import { Blueprint, Icon, SevTag } from '../../ds';
import type { ViewNote } from './model';

export interface RefTarget {
  label: string;
  domId: string;
}

interface NoteProps {
  note: ViewNote;
  state: NoteState;
  current: boolean;
  resolveRef: (id: string) => RefTarget | null;
  onPatch: (patch: NoteState) => void;
  onDelete: () => void;
  onJumpRef: (domId: string) => void;
}

export const noteDomId = (id: string): string => `note-${id}`;

const lineRange = (n: ViewNote): string =>
  n.startLine === n.endLine ? `${n.startLine}` : `${n.startLine}–${n.endLine}`;

export function NoteRow(props: NoteProps) {
  const { note: n, state: st } = props;
  const isAi = n.source === 'ai';
  const sevKind = isAi ? n.severity : 'mine';
  const sevLabel = isAi ? n.severity : 'private';
  const who = isAi ? 'PR Lens' : 'You · private';
  const text = isAi ? n.title : n.body;

  if (st.dismissed || st.collapsed) {
    return (
      <div className="note-row" id={noteDomId(n.id)} tabIndex={-1}>
        <button
          className="note-bar"
          onClick={() => props.onPatch(st.dismissed ? { dismissed: false } : { collapsed: false })}
        >
          <span className="note-who">{who}</span>
          <SevTag kind={sevKind}>{sevLabel}</SevTag>
          <span className={`note-bar-text ${st.dismissed ? 'struck' : ''}`}>
            {st.dismissed ? `Dismissed: ${text}` : text}
          </span>
          <span className="note-bar-action">{st.dismissed ? 'Restore' : 'Expand'}</span>
        </button>
      </div>
    );
  }
  return (
    <div className="note-row" id={noteDomId(n.id)} tabIndex={-1}>
      <NoteCard {...props} sevKind={sevKind} sevLabel={sevLabel} who={who} />
    </div>
  );
}

function NoteCard({
  note: n,
  state: st,
  current,
  resolveRef,
  onPatch,
  onDelete,
  onJumpRef,
  sevKind,
  sevLabel,
  who,
}: NoteProps & { sevKind: 'high' | 'medium' | 'low' | 'mine'; sevLabel: string; who: string }) {
  const [copied, setCopied] = useState(false);
  const isAi = n.source === 'ai';
  const titleId = `${noteDomId(n.id)}-title`;
  const loc = isAi
    ? `${n.startLineId === n.endLineId ? n.startLineId : `${n.startLineId}–${n.endLineId}`} · line ${lineRange(n)}`
    : `${n.lineId} · line ${lineRange(n)}`;

  const copy = (q: string): void => {
    navigator.clipboard.writeText(q).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => setCopied(false),
    );
  };

  return (
    <Blueprint
      as="section"
      className={`note-card ${isAi ? '' : 'mine'} ${current ? 'current' : ''}`}
      aria-labelledby={titleId}
    >
      <div className="note-top">
        <span className="note-who">
          {isAi && <Icon name="lens" size={13} />}
          {who}
        </span>
        <SevTag kind={sevKind}>{sevLabel}</SevTag>
        {isAi && <span className="tag tag-neutral">{CATEGORY_LABELS[n.category]}</span>}
        {st.seen && <span className="tag tag-outline">Seen</span>}
        {st.promoted && <span className="tag tag-accent">In your pending review</span>}
        <span className="note-loc">{loc}</span>
        <button
          className="btn btn-ghost icon-btn"
          title="Collapse"
          aria-label="Collapse note"
          onClick={() => onPatch({ collapsed: true })}
        >
          <Icon name="chevronUp" size={15} />
        </button>
      </div>
      {isAi ? (
        <h4 className="note-title" id={titleId}>
          {n.title}
        </h4>
      ) : (
        <span id={titleId} className="visually-hidden">
          Private note
        </span>
      )}
      <p className="note-body">{n.body}</p>
      {isAi && n.refs.length > 0 && (
        <div className="refs">
          {n.refs.map((id) => {
            const t = resolveRef(id);
            return t ? (
              <button key={id} className="ref" onClick={() => onJumpRef(t.domId)}>
                <b>{id}</b>
                {t.label}
              </button>
            ) : (
              <span key={id} className="ref">
                <b>{id}</b>
              </span>
            );
          })}
        </div>
      )}
      {isAi && n.question && (
        <div className="question">
          <div>
            <span className="kicker-mono">Question for the author</span>
            <span>{n.question}</span>
          </div>
          <button className="btn btn-ghost" onClick={() => copy(n.question ?? '')}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      <div className="note-actions">
        <button className="btn btn-secondary" disabled title="Deep dive arrives in phase 5">
          <Icon name="terminal" />
          Ask Claude
        </button>
        <button
          className="btn btn-secondary"
          disabled
          title="Promote to comment arrives in phase 6"
        >
          <Icon name="arrowUpRight" />
          Promote to comment
        </button>
        <span className="spacer" />
        <button
          className="btn btn-ghost"
          onClick={() => onPatch({ seen: !st.seen, collapsed: !st.seen })}
        >
          {st.seen ? 'Mark unseen' : 'Mark seen'}
        </button>
        <button
          className="btn btn-ghost"
          onClick={isAi ? () => onPatch({ dismissed: true }) : onDelete}
        >
          {isAi ? 'Dismiss' : 'Delete'}
        </button>
      </div>
    </Blueprint>
  );
}

export function Composer({
  location,
  onSave,
  onCancel,
}: {
  location: string;
  onSave: (body: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async (): Promise<void> => {
    if (!draft.trim() || saving) return;
    setSaving(true);
    const ok = await onSave(draft.trim());
    setSaving(false);
    if (ok) setDraft('');
  };
  return (
    <div className="note-row">
      <Blueprint className="composer">
        <label className="kicker-mono" htmlFor="composer-input">
          Private note · {location}
        </label>
        <textarea
          id="composer-input"
          className="input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
          }}
          placeholder="Only you see this. Promote it later if it should go to the author."
        />
        <div className="composer-actions">
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={!draft.trim() || saving}
          >
            Save note
          </button>
        </div>
      </Blueprint>
    </div>
  );
}
