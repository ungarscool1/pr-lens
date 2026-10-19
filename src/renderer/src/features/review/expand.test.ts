import { describe, expect, it } from 'vitest';
import { SAMPLE_DIFF } from '../../../../main/diff/fixtures';
import { buildDiffModel } from '../../../../main/diff/parse';
import { expandReveal, gapsOf, gapSize, revealRange } from './expand';
import type { Reveals } from './expand';
import { buildRows } from './model';
import type { Row } from './model';

// Old file: l1…l60. Head adds a line after l3 and deletes l51.
const DIFF = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -3,3 +3,4 @@ function top() {
 l3
+added
 l4
 l5
@@ -50,3 +51,2 @@ function bottom() {
 l50
-l51
 l52
`;
const file = buildDiffModel(DIFF, []).files[0]!;
const old = Array.from({ length: 60 }, (_, i) => `l${i + 1}`);
const head = [...old.slice(0, 3), 'added', ...old.slice(3, 50), ...old.slice(51)];

const hunks = (rows: Row[]) =>
  rows.flatMap((r) =>
    r.kind === 'hunk' ? [{ gap: r.gap, header: r.header, actions: r.actions }] : [],
  );
const extras = (rows: Row[]) =>
  rows.flatMap((r) => (r.kind === 'line' && r.cell.extra ? [r.cell.line] : []));
const at = (reveals: Reveals) => buildRows(file, [], 'unified', null, { lines: head, reveals });

describe('expanding unchanged lines', () => {
  it('finds the gaps around the hunks with their old-side offset', () => {
    const gaps = gapsOf(file, head.length);
    expect(gaps.map((g) => [g.from, g.to, g.delta])).toEqual([
      [1, 2, 0],
      [7, 50, -1],
      [53, 60, 0],
    ]);
    expect(gapsOf(file, null).map(gapSize)).toEqual([2, 44, null]);
  });

  it('offers expand actions before the text is loaded', () => {
    expect(hunks(buildRows(file, [], 'unified', null))).toEqual([
      { gap: 0, header: file.hunks[0]!.header, actions: ['all'] },
      { gap: 1, header: file.hunks[1]!.header, actions: ['down', 'up'] },
      { gap: 2, header: null, actions: ['down'] },
    ]);
  });

  it('reveals lines in steps from either hunk, then merges the gap away', () => {
    let reveals: Reveals = { 1: expandReveal(undefined, 'down') };
    let rows = at(reveals);
    const shown = extras(rows);
    expect(shown).toHaveLength(20);
    expect(shown[0]).toMatchObject({ new: 7, old: 6, text: 'l6', kind: 'ctx' });
    // Revealed lines sit between the hunk above and the gap row.
    const gapRow = rows.findIndex((r) => r.kind === 'hunk' && r.gap === 1);
    expect(rows[gapRow - 1]).toMatchObject({ kind: 'line', key: 'F1-x26' });

    reveals = { 1: expandReveal(reveals[1], 'up') };
    rows = at(reveals);
    expect(extras(rows).at(-1)).toMatchObject({ new: 50, old: 49, text: 'l49' });
    expect(hunks(rows).find((h) => h.gap === 1)?.actions).toEqual(['all']);

    rows = at({ 1: expandReveal(reveals[1], 'all') });
    expect(hunks(rows).map((h) => h.gap)).toEqual([0, 2]);
    expect(extras(rows)).toHaveLength(44);
  });

  it('knows the end of the file once loaded', () => {
    expect(hunks(at({})).at(-1)).toEqual({ gap: 2, header: null, actions: ['all'] });
    const rows = at({ 2: expandReveal(undefined, 'all') });
    expect(hunks(rows).map((h) => h.gap)).toEqual([0, 1]);
    expect(extras(rows).map((l) => l.text)).toEqual(old.slice(52));
  });

  it('pairs revealed lines with their old numbers in split view', () => {
    const rows = buildRows(file, [], 'split', null, {
      lines: head,
      reveals: { 1: { down: 1, up: 0 } },
    });
    const pair = rows.find((r) => r.key === 'F1-x7');
    expect(pair?.kind === 'pair' && [pair.left?.num, pair.right?.num, pair.left?.extra]).toEqual([
      6,
      7,
      true,
    ]);
  });

  it('reveals a range by the shorter way into its gap', () => {
    const reveals = revealRange(gapsOf(file, head.length), {}, 30, 35);
    expect(reveals).toEqual({ 1: { down: 0, up: 21 } });
    const lines = extras(at(reveals)).map((l) => l.new);
    expect(lines[0]).toBe(30);
    expect(revealRange(gapsOf(file, head.length), reveals, 31, 33)).toEqual(reveals);
  });

  it('keeps headers but offers nothing for added files', () => {
    const added = buildDiffModel(SAMPLE_DIFF, []).files.find((f) => f.path === 'src/auth/memo.ts')!;
    const rows = buildRows(added, [], 'unified', null);
    expect(hunks(rows)).toEqual([{ gap: 0, header: added.hunks[0]!.header, actions: [] }]);
  });
});
