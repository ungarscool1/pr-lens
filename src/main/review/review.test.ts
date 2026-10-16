import { describe, expect, it } from 'vitest';
import { DEFAULT_NOISE_GLOBS } from '../../shared/settings';
import type { ModelNote, ModelOutput } from '../../shared/review';
import { buildDiffModel } from '../diff/parse';
import { SAMPLE_DIFF } from '../diff/fixtures';
import { buildReviewPrompt, prContext } from './prompt';
import { rankNotes, scoreNote } from './rank';
import { normalizeLineId, validateModelOutput } from './validate';
import type { ValidNote } from './validate';

const diff = buildDiffModel(SAMPLE_DIFF, DEFAULT_NOISE_GLOBS);

const note = (over: Partial<ModelNote>): ModelNote => ({
  key: 'n1',
  anchor: { file: 'F5', start: 'F5-006', end: 'F5-006' },
  quote: 'if (!session) return null;',
  severity: 'high',
  category: 'behavior_change',
  title: 'Returns null now',
  explanation: 'Callers expect AuthError.',
  confidence: 0.85,
  ...over,
});

const output = (notes: ModelNote[]): ModelOutput => ({
  summary: 'Adds a memo.',
  files: [
    { file: 'F5', risk: 'high', why: 'contract' },
    { file: 'f4', risk: 'medium', why: 'cache' },
    { file: 'F9', risk: 'low', why: 'x' },
  ],
  reading_order: ['F4', 'F5', 'F4'],
  notes,
});

describe('normalizeLineId', () => {
  it.each([
    ['F2-03', 'F2-003'],
    [' f2-3 ', 'F2-003'],
    ['F12-1234', 'F12-1234'],
    ['C1', 'C1'],
  ])('%s → %s', (a, b) => expect(normalizeLineId(a)).toBe(b));
});

describe('validateModelOutput', () => {
  it('resolves an added-line anchor to the right side and new line number', () => {
    const { notes } = validateModelOutput(output([note({})]), diff);
    expect(notes[0]).toMatchObject({
      path: 'src/auth/session.ts',
      side: 'RIGHT',
      startLine: 41,
      endLine: 41,
      repaired: false,
    });
  });

  it('resolves a span of removed lines to the LEFT side', () => {
    const { notes } = validateModelOutput(
      output([note({ anchor: { file: 'F5', start: 'F5-003', end: 'F5-004' } })]),
      diff,
    );
    expect(notes[0]).toMatchObject({ side: 'LEFT', startLine: 40, endLine: 41 });
  });

  it('repairs padding, reversed spans and cross-file ends', () => {
    const { notes } = validateModelOutput(
      output([
        note({
          key: 'n1',
          anchor: { file: 'F4', start: 'F4-03', end: 'F4-03' },
          quote: 'new Map<string',
        }),
        note({
          key: 'n2',
          anchor: { file: 'F5', start: 'F5-007', end: 'F5-005' },
          quote: '?? memo.get',
        }),
        note({
          key: 'n3',
          anchor: { file: 'F5', start: 'F5-005', end: 'F4-001' },
          quote: '?? memo.get',
        }),
      ]),
      diff,
    );
    expect(notes.map((n) => [n.startLineId, n.endLineId, n.repaired, n.confidence])).toEqual([
      ['F4-003', 'F4-003', true, 0.85],
      ['F5-005', 'F5-007', true, 0.85],
      ['F5-005', 'F5-005', true, 0.85],
    ]);
  });

  it('finds an unknown start again by its quote', () => {
    const { notes } = validateModelOutput(
      output([
        note({
          anchor: { file: 'F5', start: 'F5-099', end: 'F5-099' },
          quote: 'metrics.increment(',
        }),
      ]),
      diff,
    );
    expect(notes[0]).toMatchObject({
      startLineId: 'F5-010',
      endLineId: 'F5-010',
      startLine: 45,
      repaired: true,
    });
  });

  it('refuses to guess when the quote matches several lines', () => {
    const r = validateModelOutput(
      output([note({ anchor: { file: 'F7', start: 'F7-001', end: 'F7-001' }, quote: 'session' })]),
      diff,
    );
    expect(r.notes).toEqual([]);
    expect(r.dropped[0]?.reason).toBe('unknown line F7-001, quote not found');
  });

  it('moves the start to the line in the span that holds the quote, or lowers confidence', () => {
    const { notes } = validateModelOutput(
      output([
        note({
          key: 'n1',
          anchor: { file: 'F5', start: 'F5-005', end: 'F5-007' },
          quote: 'memo.set(token',
        }),
        note({
          key: 'n2',
          anchor: { file: 'F5', start: 'F5-005', end: 'F5-005' },
          quote: 'not on this line',
        }),
      ]),
      diff,
    );
    expect(notes[0]).toMatchObject({ startLineId: 'F5-007', endLineId: 'F5-007', repaired: true });
    expect(notes[1]).toMatchObject({ startLineId: 'F5-005', confidence: 0.65 });
  });

  it('keeps a note on a shown file as file-level when no line can be found', () => {
    const { notes } = validateModelOutput(
      output([
        note({
          anchor: { file: 'F4', start: 'F4-900', end: 'F4-900' },
          quote: 'nothing like this',
        }),
      ]),
      diff,
    );
    expect(notes[0]).toMatchObject({ fid: 'F4', fileLevel: true, startLine: 0, startLineId: '' });
  });

  it('truncates spans to 20 lines', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `+line ${i}`).join('\n');
    const big = buildDiffModel(
      `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,30 @@\n${lines}\n`,
      [],
    );
    const { notes } = validateModelOutput(
      output([note({ anchor: { file: 'F1', start: 'F1-001', end: 'F1-030' }, quote: 'line 0' })]),
      big,
    );
    expect(notes[0]).toMatchObject({
      startLine: 1,
      endLine: 20,
      endLineId: 'F1-020',
      repaired: true,
    });
  });

  it('drops notes anchored to lines that do not exist in files it was not shown', () => {
    const r = validateModelOutput(
      output([
        note({
          anchor: { file: 'F3', start: 'F3-001', end: 'F3-001' },
          quote: "lockfileVersion: '9.0'",
        }),
      ]),
      diff,
    );
    expect(r.notes).toEqual([]);
    expect(r.dropped[0]).toMatchObject({ key: 'n1' });
  });

  it('keeps only known files and completes the reading order', () => {
    const r = validateModelOutput(output([]), diff);
    expect(r.files.map((f) => f.fid)).toEqual(['F5', 'F4']);
    expect(r.readingOrder).toEqual(['F4', 'F5', 'F1', 'F2']);
  });

  it('gives the same note the same identity on a re-run', () => {
    const a = validateModelOutput(output([note({})]), diff).notes[0]!.id;
    const b = validateModelOutput(output([note({ title: 'Reworded', confidence: 0.5 })]), diff)
      .notes[0]!.id;
    expect(a).toBe(b);
  });
});

describe('rankNotes', () => {
  const v = (over: Partial<ValidNote>): ValidNote => ({
    ...validateModelOutput(output([note({})]), diff).notes[0]!,
    ...over,
  });

  it('scores by severity × confidence × category weight', () => {
    expect(scoreNote({ severity: 'high', confidence: 0.8, category: 'security' })).toBe(2.88);
    expect(scoreNote({ severity: 'low', confidence: 0.5, category: 'missing_tests' })).toBe(0.4);
  });

  it('orders by score, drops weak lows and caps without cutting highs', () => {
    const notes = [
      v({ id: 'ai-low-weak', severity: 'low', confidence: 0.3, startLine: 1, endLine: 1 }),
      v({ id: 'ai-med', severity: 'medium', confidence: 1, category: 'security' }),
      v({ id: 'ai-high-a', severity: 'high', confidence: 0.3, startLine: 10, endLine: 10 }),
      v({ id: 'ai-high-b', severity: 'high', confidence: 0.9, startLine: 20, endLine: 22 }),
    ];
    const { kept, cut } = rankNotes(notes, 2);
    expect(kept.map((n) => n.id)).toEqual(['ai-high-b', 'ai-high-a']);
    expect(cut.map((c) => [c.key, c.reason])).toEqual([
      ['ai-low-weak', 'low severity and low confidence'],
      ['ai-med', 'over the note cap'],
    ]);
  });

  it('merges notes on overlapping lines with the same category, keeping the stronger', () => {
    const { kept, cut } = rankNotes(
      [
        v({ id: 'ai-a', confidence: 0.6, startLine: 40, endLine: 42 }),
        v({ id: 'ai-b', confidence: 0.9, startLine: 42, endLine: 44 }),
        v({ id: 'ai-c', confidence: 0.9, startLine: 42, endLine: 44, category: 'security' }),
      ],
      8,
    );
    expect(kept.map((n) => n.id)).toEqual(['ai-c', 'ai-b']);
    expect(cut).toEqual([{ key: 'ai-a', title: 'Returns null now', reason: 'duplicate' }]);
  });

  it('never keeps more than the cap, highs first', () => {
    const highs = Array.from({ length: 12 }, (_, i) =>
      v({ id: `ai-h${i}`, startLine: i * 5 + 1, endLine: i * 5 + 1 }),
    );
    expect(rankNotes(highs, 10).kept).toHaveLength(10);
  });
});

describe('buildReviewPrompt', () => {
  const meta = {
    url: '',
    title: 'Cache sessions',
    body: 'token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"',
    state: 'OPEN' as const,
    isDraft: false,
    author: 'maria-k',
    baseRefName: 'main',
    headRefName: 'feat',
    baseSha: '3f2a91c0',
    headSha: '9bd04e10',
    commitCount: 3,
    linkedIssues: [],
  };
  const built = buildReviewPrompt(
    prContext({ owner: 'acme', repo: 'api', number: 812 }, meta),
    diff,
    8,
  );

  it('shows line IDs and markers for reviewed files only', () => {
    expect(built.prompt).toContain(
      'F5-005 +   const session = (await store.get(token)) ?? memo.get(token);',
    );
    expect(built.prompt).toContain('F3 pnpm-lock.yaml modified +1 -1 noise:**/pnpm-lock.yaml');
    expect(built.prompt).not.toContain('F3-001');
  });

  it('redacts secrets and reports them', () => {
    expect(built.prompt).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(built.redactions).toContainEqual({ lineId: null, kind: 'github-token' });
  });

  it('estimates tokens', () => {
    expect(built.estimatedTokens).toBeGreaterThan(100);
  });
});
