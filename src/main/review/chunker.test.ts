import { describe, expect, it } from 'vitest';
import { DEFAULT_NOISE_GLOBS } from '../../shared/settings';
import { buildDiffModel } from '../diff/parse';
import { SAMPLE_DIFF } from '../diff/fixtures';
import { isTestPath, planChunks } from './chunker';

/** A diff with one added file per entry: [path, lines per hunk...]. */
function makeDiff(files: [string, ...number[]][]): string {
  return files
    .map(([path, ...hunks]) => {
      let start = 1;
      const body = hunks
        .map((n) => {
          const h = `@@ -0,0 +${start},${n} @@\n${Array.from({ length: n }, (_, i) => `+${path} line ${start + i} ${'x'.repeat(60)}`).join('\n')}`;
          start += n + 10;
          return h;
        })
        .join('\n');
      return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n${body}`;
    })
    .join('\n');
}

const allLineIds = (
  diff: ReturnType<typeof buildDiffModel>,
  fid: string,
  hunks: number[] | null,
) => {
  const f = diff.files.find((x) => x.fid === fid)!;
  return f.hunks
    .filter((_, i) => hunks === null || hunks.includes(i))
    .flatMap((h) => h.lines.map((l) => l.id));
};

describe('isTestPath', () => {
  it.each([
    ['src/a.test.ts', true],
    ['pkg/a_test.go', true],
    ['web/__tests__/a.tsx', true],
    ['test/a.py', true],
    ['src/contest.ts', false],
  ])('%s → %s', (p, t) => expect(isTestPath(p)).toBe(t));
});

describe('planChunks', () => {
  it('keeps a small PR in one chunk and skips noise and binaries', () => {
    const diff = buildDiffModel(SAMPLE_DIFF, DEFAULT_NOISE_GLOBS);
    const chunks = planChunks(diff, 90_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.items.map((i) => i.fid)).toEqual(['F4', 'F5']);
  });

  it('covers every reviewed line exactly once and respects the budget', () => {
    const diff = buildDiffModel(
      makeDiff([
        ['api/a.ts', 120],
        ['api/b.ts', 120],
        ['web/c.ts', 120],
        ['web/d.ts', 120],
        ['lib/e.ts', 40, 40, 40, 40, 40, 40],
      ]),
      [],
    );
    const budget = 6_000;
    const chunks = planChunks(diff, budget);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.tokens).toBeLessThanOrEqual(budget);
    const seen = chunks.flatMap((c) => c.items.flatMap((i) => allLineIds(diff, i.fid, i.hunks)));
    const expected = diff.files.flatMap((f) => allLineIds(diff, f.fid, null));
    expect([...seen].sort()).toEqual([...expected].sort());
  });

  it('splits a file over budget by hunks', () => {
    const diff = buildDiffModel(makeDiff([['big.ts', 50, 50, 50, 50]]), []);
    const chunks = planChunks(diff, 2_500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((c) => c.items.flatMap((i) => i.hunks ?? []))).toEqual([0, 1, 2, 3]);
  });

  it('keeps a test with its source even in another directory', () => {
    const diff = buildDiffModel(
      makeDiff([
        ['src/session.ts', 60],
        ['test/session.test.ts', 60],
        ['web/x.ts', 60],
        ['docs/y.ts', 60],
      ]),
      [],
    );
    const chunks = planChunks(diff, 4_000);
    const withSource = chunks.find((c) =>
      c.items.some((i) => diff.files.find((f) => f.fid === i.fid)?.path === 'src/session.ts'),
    )!;
    const paths = withSource.items.map((i) => diff.files.find((f) => f.fid === i.fid)?.path);
    expect(paths).toContain('test/session.test.ts');
  });

  it('is deterministic', () => {
    const diff = buildDiffModel(
      makeDiff([
        ['a/x.ts', 100],
        ['b/y.ts', 100],
        ['c/z.ts', 100],
      ]),
      [],
    );
    expect(planChunks(diff, 5_000)).toEqual(planChunks(diff, 5_000));
  });
});
