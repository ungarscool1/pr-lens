import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Subject } from '../../shared/subject';
import { createJsonStore } from '../store/json-store';
import { createNotes } from './notes';

const subject: Subject = { kind: 'pr', ref: { owner: 'acme', repo: 'api', number: 812 } };
const FILE = 'notes/acme__api__812.json';

const tempNotes = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pr-lens-notes-'));
  return { dir, notes: createNotes(createJsonStore(dir)) };
};

const draft = (body = 'mine') => ({
  path: 'src/a.ts',
  side: 'RIGHT' as const,
  line: 4,
  lineId: 'F1-004',
  body,
});

describe('notes service', () => {
  it('updates a private note body, AI edits and links, and persists them', async () => {
    const { dir, notes } = await tempNotes();
    const n = await notes.create(subject, draft());
    await notes.updateBody(subject, n.id, 'changed');
    await notes.setEdit(subject, 'ai-abcd1234', 'better wording');
    await notes.setPublished(subject, n.id, { commentId: 'PRRC_1', body: 'changed' });

    // A fresh service reads the same file back.
    const again = await createNotes(createJsonStore(dir)).list(subject);
    expect(again.mine.map((x) => x.body)).toEqual(['changed']);
    expect(again.edits).toEqual({ 'ai-abcd1234': { body: 'better wording' } });
    expect(again.published).toEqual({ [n.id]: { commentId: 'PRRC_1', body: 'changed' } });

    await notes.setPublished(subject, n.id, null);
    expect((await notes.list(subject)).published).toEqual({});
  });

  it('refuses to update the body of a deleted note and writes nothing', async () => {
    const { notes } = await tempNotes();
    await expect(notes.updateBody(subject, 'me-gone1234', 'x')).rejects.toThrow(/deleted/);
    expect(await notes.list(subject)).toEqual({ mine: [], state: {}, edits: {}, published: {} });
  });

  it('drops the edit and link of a deleted note, and clears links in one go', async () => {
    const { notes } = await tempNotes();
    const a = await notes.create(subject, draft('a'));
    const b = await notes.create(subject, draft('b'));
    await notes.patchState(subject, a.id, { promoted: true });
    await notes.setEdit(subject, a.id, 'edit');
    await notes.setPublished(subject, a.id, { commentId: 'PRRC_a', body: 'a' });
    await notes.setPublished(subject, b.id, { commentId: 'PRRC_b', body: 'b' });

    await notes.delete(subject, a.id);
    let f = await notes.list(subject);
    expect(f.mine.map((x) => x.id)).toEqual([b.id]);
    expect(f.state).toEqual({});
    expect(f.edits).toEqual({});
    expect(Object.keys(f.published)).toEqual([b.id]);

    await notes.clearPublished(subject);
    f = await notes.list(subject);
    expect(f.published).toEqual({});
    expect(f.mine).toHaveLength(1);
  });

  it('loads an older file without edits or links', async () => {
    const { dir, notes } = await tempNotes();
    await mkdir(join(dir, 'notes'), { recursive: true });
    const old = {
      mine: [{ ...draft(), id: 'me-abcd1234', source: 'me', createdAt: 1 }],
      state: { 'ai-abcd1234': { seen: true } },
    };
    await writeFile(join(dir, FILE), JSON.stringify(old));
    const f = await notes.list(subject);
    expect(f).toEqual({ ...old, edits: {}, published: {} });

    // The next write adds the new fields and keeps the old ones.
    await notes.setEdit(subject, 'ai-abcd1234', 'e');
    const raw = JSON.parse(await readFile(join(dir, FILE), 'utf8'));
    expect(raw).toMatchObject({ state: old.state, edits: { 'ai-abcd1234': { body: 'e' } } });
  });

  it('accepts a private note body up to the comment limit', async () => {
    const { notes } = await tempNotes();
    const n = await notes.create(subject, draft());
    const long = 'x'.repeat(65_000);
    await notes.updateBody(subject, n.id, long);
    expect((await notes.list(subject)).mine[0]?.body).toBe(long);
  });

  it('does not lose updates made at the same time', async () => {
    const { notes } = await tempNotes();
    const n = await notes.create(subject, draft());
    await Promise.all([
      notes.updateBody(subject, n.id, 'body'),
      notes.setEdit(subject, 'ai-aaaa1111', 'one'),
      notes.setEdit(subject, 'ai-bbbb2222', 'two'),
      notes.setPublished(subject, n.id, { commentId: 'PRRC_1', body: 'body' }),
      notes.patchState(subject, n.id, { promoted: true }),
    ]);
    const f = await notes.list(subject);
    expect(f.mine[0]?.body).toBe('body');
    expect(Object.keys(f.edits).sort()).toEqual(['ai-aaaa1111', 'ai-bbbb2222']);
    expect(f.published[n.id]?.commentId).toBe('PRRC_1');
    expect(f.state[n.id]).toEqual({ promoted: true });
  });
});
