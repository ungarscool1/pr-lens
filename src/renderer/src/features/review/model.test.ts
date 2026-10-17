import { describe, expect, it } from 'vitest';
import { SAMPLE_DIFF } from '../../../../main/diff/fixtures';
import { buildDiffModel } from '../../../../main/diff/parse';
import type { PrivateNote } from '../../../../shared/notes';
import type { AiNote } from '../../../../shared/review';
import { buildRows, highlightedLines, navigableNotes, stepNote, toViewNotes } from './model';

const file = buildDiffModel(SAMPLE_DIFF, []).files.find((f) => f.path === 'src/auth/session.ts')!;

const ai = (id: string, score: number, over: Partial<AiNote> = {}): AiNote => ({
  id,
  source: 'ai',
  fid: file.fid,
  path: file.path,
  side: 'RIGHT',
  startLineId: 'F5-006',
  endLineId: 'F5-006',
  startLine: 41,
  endLine: 41,
  severity: 'high',
  category: 'behavior_change',
  title: id,
  body: '',
  refs: [],
  confidence: 1,
  score,
  repaired: false,
  fileLevel: false,
  ...over,
});
const mine: PrivateNote = {
  id: 'me-abcd1234',
  source: 'me',
  path: file.path,
  side: 'LEFT',
  line: 40,
  lineId: 'F5-003',
  body: 'mine',
  createdAt: 0,
};

describe('notes', () => {
  const notes = toViewNotes([ai('ai-low', 1, { severity: 'medium' }), ai('ai-top', 3)], [mine]);

  it('orders AI notes by score, then private notes', () => {
    expect(notes.map((n) => n.id)).toEqual(['ai-top', 'ai-low', 'me-abcd1234']);
    expect(notes[2]).toMatchObject({ fid: 'F5', side: 'LEFT', startLine: 40 });
  });

  it('navigates with wrap-around, skipping dismissed and filtered notes', () => {
    const list = navigableNotes(notes, { 'ai-low': { dismissed: true } }, 'all');
    expect(list.map((n) => n.id)).toEqual(['ai-top', 'me-abcd1234']);
    expect(stepNote(list, null, 1)?.id).toBe('ai-top');
    expect(stepNote(list, 'me-abcd1234', 1)?.id).toBe('ai-top');
    expect(stepNote(list, null, -1)?.id).toBe('me-abcd1234');
    expect(navigableNotes(notes, {}, 'high').map((n) => n.id)).toEqual(['ai-top']);
    expect(navigableNotes(notes, {}, 'medium').map((n) => n.id)).toEqual(['ai-low']);
    expect(navigableNotes(notes, { 'ai-top': { seen: true } }, 'unseen').map((n) => n.id)).toEqual([
      'ai-low',
      'me-abcd1234',
    ]);
  });

  it('highlights only open notes', () => {
    const hl = highlightedLines(notes, { 'ai-top': { collapsed: true } });
    expect([...hl.RIGHT]).toEqual([41]);
    expect([...hl.LEFT]).toEqual([40]);
  });
});

describe('buildRows', () => {
  const notes = toViewNotes([ai('ai-top', 3)], [mine]);

  it('unified: one row per line, notes after their end line', () => {
    const rows = buildRows(file, notes, 'unified', null);
    expect(rows.filter((r) => r.kind === 'line')).toHaveLength(12);
    const keys = rows.map((r) => r.key);
    expect(keys.indexOf('note-me-abcd1234')).toBe(keys.indexOf('F5-003') + 1);
    expect(keys.indexOf('note-ai-top')).toBe(keys.indexOf('F5-006') + 1);
  });

  it('split: pairs removals with additions and places the composer', () => {
    const rows = buildRows(file, [], 'split', {
      fid: 'F5',
      side: 'RIGHT',
      line: 42,
      lineId: 'F5-007',
    });
    const pairs = rows.filter((r) => r.kind === 'pair');
    expect(pairs).toHaveLength(10);
    const third = pairs[2];
    expect(third?.kind === 'pair' && [third.left?.line.id, third.right?.line.id]).toEqual([
      'F5-003',
      'F5-005',
    ]);
    const fifth = pairs[4];
    expect(fifth?.kind === 'pair' && [fifth.left, fifth.right?.line.id]).toEqual([null, 'F5-007']);
    expect(rows[rows.findIndex((r) => r.key === fifth?.key) + 1]?.kind).toBe('composer');
  });

  it('puts file-level notes above the first hunk and does not highlight them', () => {
    const fl = ai('ai-file', 2, {
      fileLevel: true,
      startLine: 0,
      endLine: 0,
      startLineId: '',
      endLineId: '',
    });
    const rows = buildRows(file, toViewNotes([fl], []), 'unified', null);
    expect(rows[0]).toMatchObject({ kind: 'note', key: 'note-ai-file' });
    expect(rows.filter((r) => r.kind === 'note')).toHaveLength(1);
    expect(highlightedLines(toViewNotes([fl], []), {}).RIGHT.size).toBe(0);
  });

  it('marks the changed span of a modified line', () => {
    const rows = buildRows(file, [], 'unified', null);
    const row = rows.find((r) => r.key === 'F5-005');
    const changed =
      row?.kind === 'line'
        ? row.cell.toks
            .filter((t) => t.changed)
            .map((t) => t.s)
            .join('')
        : '';
    expect(changed).toBe('(await store.get(token)) ?? memo');
  });
});
