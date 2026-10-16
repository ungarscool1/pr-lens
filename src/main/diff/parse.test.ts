import { describe, expect, it } from 'vitest';
import { DEFAULT_NOISE_GLOBS } from '../../shared/settings';
import { SAMPLE_DIFF } from './fixtures';
import { buildDiffModel, noiseMatcher, parseUnifiedDiff } from './parse';

describe('parseUnifiedDiff', () => {
  const files = parseUnifiedDiff(SAMPLE_DIFF);
  const byPath = (p: string) => files.find((f) => f.path === p);

  it('finds every file with its status', () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['src/auth/session.ts', 'modified'],
      ['src/auth/memo.ts', 'added'],
      ['pnpm-lock.yaml', 'modified'],
      ['docs/new name.md', 'renamed'],
      ['logo.png', 'modified'],
    ]);
  });

  it('numbers old and new lines from the hunk header', () => {
    const lines = byPath('src/auth/session.ts')!.hunks[0]!.lines;
    expect(lines[0]).toMatchObject({ kind: 'ctx', old: 38, new: 38 });
    expect(lines[2]).toMatchObject({
      kind: 'del',
      old: 40,
      text: '  const session = await store.get(token);',
    });
    expect(lines[4]).toMatchObject({ kind: 'add', new: 40 });
    expect(lines.at(-1)).toMatchObject({ kind: 'ctx', old: 44, new: 47 });
  });

  it('counts additions and deletions and skips "no newline" markers', () => {
    expect(byPath('src/auth/session.ts')).toMatchObject({ additions: 5, deletions: 2 });
    const memo = byPath('src/auth/memo.ts')!;
    expect(memo).toMatchObject({ additions: 7, deletions: 0 });
    expect(memo.hunks[0]!.lines).toHaveLength(7);
  });

  it('keeps the old path of renames and flags binaries', () => {
    expect(byPath('docs/new name.md')).toMatchObject({ oldPath: 'docs/old name.md', hunks: [] });
    expect(byPath('logo.png')!.binary).toBe(true);
  });

  it('decodes C-quoted paths', () => {
    const diff =
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n--- "a/caf\\303\\251.txt"\n+++ "b/caf\\303\\251.txt"\n@@ -1 +1 @@\n-a\n+b\n';
    expect(parseUnifiedDiff(diff)[0]!.path).toBe('café.txt');
  });
});

describe('buildDiffModel', () => {
  const model = buildDiffModel(SAMPLE_DIFF, DEFAULT_NOISE_GLOBS);

  it('sorts files by path and numbers them F1…Fn', () => {
    expect(model.files.map((f) => `${f.fid} ${f.path}`)).toEqual([
      'F1 docs/new name.md',
      'F2 logo.png',
      'F3 pnpm-lock.yaml',
      'F4 src/auth/memo.ts',
      'F5 src/auth/session.ts',
    ]);
  });

  it('gives every line a zero-padded ID that runs across hunks', () => {
    const ids = model.files[4]!.hunks.flatMap((h) => h.lines.map((l) => l.id));
    expect(ids[0]).toBe('F5-001');
    expect(ids.at(-1)).toBe('F5-012');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks noise files with the glob that matched', () => {
    expect(model.files[2]!.noise).toBe('**/pnpm-lock.yaml');
    expect(model.files[4]!.noise).toBeNull();
  });

  it('is deterministic', () => {
    expect(buildDiffModel(SAMPLE_DIFF, DEFAULT_NOISE_GLOBS)).toEqual(model);
  });
});

describe('noiseMatcher', () => {
  const m = noiseMatcher(DEFAULT_NOISE_GLOBS);
  it.each([
    ['package-lock.json', '**/package-lock.json'],
    ['web/src/__snapshots__/App.test.tsx.snap', '**/__snapshots__/**'],
    ['dist/app.min.js', '**/*.min.js'],
    ['src/index.ts', null],
  ])('%s → %s', (path, glob) => expect(m(path)).toBe(glob));
});
