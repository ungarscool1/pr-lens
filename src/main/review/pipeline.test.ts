import { describe, expect, it } from 'vitest';
import { AppError } from '../../shared/errors';
import type { PrMeta } from '../../shared/pr';
import type { MergeOutput, ModelOutput } from '../../shared/review';
import { buildDiffModel } from '../diff/parse';
import type { ClaudeClient, ClaudeRunRequest } from './claude';
import { createLimiter } from './limiter';
import { runReviewPipeline } from './pipeline';
import type { PipelineInput } from './pipeline';

const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 };

/** One ~2.4k-token file per directory, so a small budget forces one chunk per file. */
const diffOf = (dirs: string[]) =>
  buildDiffModel(
    dirs
      .map((dir) => {
        const lines = Array.from(
          { length: 120 },
          (_, i) => `+${dir} value ${i} = compute(${i}) ${'y'.repeat(40)}`,
        );
        return `diff --git a/${dir}/m.ts b/${dir}/m.ts\nnew file mode 100644\n--- /dev/null\n+++ b/${dir}/m.ts\n@@ -0,0 +1,120 @@\n${lines.join('\n')}`;
      })
      .join('\n'),
    [],
  );
const diff = diffOf(['api', 'web', 'lib', 'cli']);
const meta: PrMeta = {
  url: '',
  title: 'T',
  body: '',
  state: 'OPEN',
  isDraft: false,
  author: 'a',
  baseRefName: 'main',
  headRefName: 'f',
  baseSha: 'aaaaaaa1',
  headSha: 'bbbbbbb2',
  commitCount: 1,
  linkedIssues: [],
};

/** Answers each chunk with one high note on the first line it was shown (plus one bogus note). */
function fakeClaude(opts: { failChunk?: number; failMerge?: boolean } = {}) {
  const calls: { kind: 'review' | 'merge'; prompt: string }[] = [];
  const client: ClaudeClient = {
    health: () => Promise.reject(new Error('unused')),
    async review(req: ClaudeRunRequest) {
      calls.push({ kind: 'review', prompt: req.prompt });
      const chunk = Number(/chunk="(\d+)\//.exec(req.prompt)?.[1]);
      if (chunk === opts.failChunk) throw new AppError('MODEL_ERROR');
      const m = /^(F(\d+)-\d+) \+ (.*)$/m.exec(req.prompt);
      const output: ModelOutput = {
        summary: `chunk ${chunk}`,
        files: [{ file: `F${m?.[2]}`, risk: 'high', why: 'w' }],
        reading_order: [`F${m?.[2]}`],
        notes: [
          {
            key: 'n1',
            anchor: { file: `F${m?.[2]}`, start: m?.[1] ?? '', end: m?.[1] ?? '' },
            quote: m?.[3]?.slice(0, 20) ?? '',
            severity: 'high',
            category: 'correctness',
            title: `issue ${chunk}`,
            explanation: 'e',
            confidence: 0.9,
          },
          {
            key: 'n2',
            anchor: { file: 'F99', start: 'F99-001', end: 'F99-001' },
            quote: 'nowhere at all',
            severity: 'low',
            category: 'other',
            title: 'bogus',
            explanation: 'e',
            confidence: 0.9,
          },
        ],
      };
      return { output, usage };
    },
    async merge(req: ClaudeRunRequest) {
      calls.push({ kind: 'merge', prompt: req.prompt });
      if (opts.failMerge) throw new AppError('MODEL_BAD_JSON');
      const keys = [...req.prompt.matchAll(/^(c\d+\.n\d+) /gm)].map((x) => x[1] ?? '');
      const output: MergeOutput = {
        summary: 'merged',
        files: [],
        reading_order: [],
        notes: [
          {
            from: [keys[0] ?? '', keys[1] ?? ''],
            severity: 'high',
            category: 'correctness',
            title: 'combined',
            explanation: 'both',
            confidence: 0.8,
          },
          {
            from: ['c9.n9'],
            severity: 'low',
            category: 'other',
            title: 'invented',
            explanation: 'x',
            confidence: 0.5,
          },
        ],
      };
      return { output, usage };
    },
  };
  return { client, calls };
}

const input = (over: Partial<PipelineInput> = {}): PipelineInput => ({
  target: { key: 'o/r#1@bbbbbbb2', ref: { owner: 'o', repo: 'r', number: 1 }, headSha: 'bbbbbbb2' },
  meta,
  diff,
  settings: { maxNotes: 8, model: null, reviewTimeoutSec: 60 },
  sandboxDir: '/tmp',
  signal: new AbortController().signal,
  onProgress: () => undefined,
  limit: createLimiter(2),
  ...over,
});

describe('runReviewPipeline', () => {
  it('reviews a small PR in one pass, without a merge', async () => {
    const { client, calls } = fakeClaude();
    const a = await runReviewPipeline(client, input());
    expect(calls.map((c) => c.kind)).toEqual(['review']);
    expect(a).toMatchObject({ chunks: 1, failedChunks: 0, merge: 'none', summary: 'chunk 1' });
    expect(a.notes).toHaveLength(1);
    expect(a.dropped.map((d) => d.key)).toEqual(['n2']);
  });

  it('chunks a big PR, shows each chunk only its files, and merges by candidate key', async () => {
    const { client, calls } = fakeClaude();
    const progress: string[] = [];
    const a = await runReviewPipeline(
      client,
      input({ budget: 4_000, onProgress: (m) => progress.push(m) }),
    );
    const reviews = calls.filter((c) => c.kind === 'review');
    expect(reviews.length).toBeGreaterThan(1);
    expect(reviews[0]?.prompt).toContain('other-chunk');
    expect(calls.at(-1)?.kind).toBe('merge');
    expect(a).toMatchObject({ chunks: reviews.length, merge: 'model', summary: 'merged' });
    expect(a.notes.map((n) => n.title)).toEqual(['combined']);
    expect(a.dropped.map((d) => d.reason)).toContain('merge cited no known candidate');
    expect(a.dropped.some((d) => d.key === 'c1.n2')).toBe(true);
    expect(a.usage.inputTokens).toBe(100 * calls.length);
    expect(progress.at(-1)).toBe('Merging chunk results…');
  });

  it('keeps going when one chunk fails, and falls back to rules when the merge fails', async () => {
    const { client } = fakeClaude({ failChunk: 1, failMerge: true });
    const a = await runReviewPipeline(client, input({ budget: 4_000 }));
    expect(a.failedChunks).toBe(1);
    expect(a.merge).toBe('fallback');
    expect(a.notes.length).toBe(a.chunks - 1);
    expect(a.summary).not.toContain('chunk 1');
  });

  it('fails when every chunk fails, and stops on cancel', async () => {
    const { client } = fakeClaude({ failChunk: 1 });
    await expect(runReviewPipeline(client, input())).rejects.toMatchObject({ code: 'MODEL_ERROR' });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      runReviewPipeline(fakeClaude().client, input({ signal: ctrl.signal })),
    ).rejects.toMatchObject({
      code: 'CANCELLED',
    });
  });

  it('refuses a PR that needs too many chunks', async () => {
    const huge = diffOf(Array.from({ length: 10 }, (_, i) => `d${i}`));
    await expect(
      runReviewPipeline(fakeClaude().client, input({ diff: huge, budget: 4_000 })),
    ).rejects.toMatchObject({
      code: 'PR_TOO_LARGE',
    });
  });
});
