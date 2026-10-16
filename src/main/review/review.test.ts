import { describe, expect, it } from 'vitest';
import { DEFAULT_NOISE_GLOBS } from '../../shared/settings';
import type { ModelNote, ModelOutput } from '../../shared/review';
import { buildDiffModel } from '../diff/parse';
import { SAMPLE_DIFF } from '../diff/fixtures';
import { buildReviewPrompt } from './prompt';
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
        note({ key: 'n1', anchor: { file: 'F4', start: 'F4-03', end: 'F4-03' } }),
        note({ key: 'n2', anchor: { file: 'F5', start: 'F5-007', end: 'F5-005' } }),
        note({ key: 'n3', anchor: { file: 'F5', start: 'F5-005', end: 'F4-001' } }),
      ]),
      diff,
    );
    expect(notes.map((n) => [n.startLineId, n.endLineId, n.repaired])).toEqual([
      ['F4-003', 'F4-003', true],
      ['F5-005', 'F5-007', true],
      ['F5-005', 'F5-005', true],
    ]);
  });

  it('drops notes anchored to lines that do not exist', () => {
    const r = validateModelOutput(
      output([note({ anchor: { file: 'F9', start: 'F9-001', end: 'F9-001' } })]),
      diff,
    );
    expect(r.notes).toEqual([]);
    expect(r.dropped[0]).toMatchObject({ key: 'n1', reason: 'unknown line F9-001' });
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
      v({ id: 'ai-low-weak', severity: 'low', confidence: 0.3 }),
      v({ id: 'ai-med', severity: 'medium', confidence: 1, category: 'security' }),
      v({ id: 'ai-high-a', severity: 'high', confidence: 0.3 }),
      v({ id: 'ai-high-b', severity: 'high', confidence: 0.9 }),
    ];
    const { kept, cut } = rankNotes(notes, 2);
    expect(kept.map((n) => n.id)).toEqual(['ai-high-b', 'ai-high-a']);
    expect(cut.map((c) => [c.key, c.reason])).toEqual([
      ['ai-low-weak', 'low severity and low confidence'],
      ['ai-med', 'over the note cap'],
    ]);
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
  const built = buildReviewPrompt({ owner: 'acme', repo: 'api', number: 812 }, meta, diff, 8);

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
