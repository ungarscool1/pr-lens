import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePrInput } from '../../shared/pr';
import { targetKeyOf } from '../../shared/subject';
import { DEFAULT_NOISE_GLOBS } from '../../shared/settings';
import { buildDiffModel } from '../diff/parse';
import { execFileRunner } from '../exec/exec';
import { createToolchain } from '../exec/toolchain';
import { createGhClient } from '../github/gh';
import { createClaudeClient } from './claude';
import { createLimiter } from './limiter';
import { runReviewPipeline } from './pipeline';
import { prContext } from './prompt';

/**
 * Live smoke test against real gh + claude, no window. Costs real tokens, so it only runs on
 * request:  PR_LENS_LIVE=1 PR_LENS_LIVE_PR=cli/cli#14104 PR_LENS_LIVE_BUDGET=30000 pnpm test pipeline.live
 */
describe.skipIf(!process.env.PR_LENS_LIVE)('live review pipeline', () => {
  it(
    'reviews a real PR in chunks and anchors every note to a real line',
    async () => {
      const ref = parsePrInput(process.env.PR_LENS_LIVE_PR ?? 'cli/cli#14104');
      if (!ref) throw new Error('bad PR_LENS_LIVE_PR');
      const toolchain = createToolchain(execFileRunner, () => ({ ghPath: null, claudePath: null }));
      const gh = createGhClient(execFileRunner, toolchain);
      const claude = createClaudeClient(execFileRunner, toolchain, async () => null);
      const [meta, text] = await Promise.all([gh.prMeta(ref), gh.prDiff(ref)]);
      const diff = buildDiffModel(text, DEFAULT_NOISE_GLOBS);
      const progress: string[] = [];

      const a = await runReviewPipeline(claude, {
        target: {
          key: targetKeyOf({ kind: 'pr', ref }, meta.headSha),
          subject: { kind: 'pr', ref },
          headSha: meta.headSha,
        },
        context: prContext(ref, meta),
        diff,
        settings: { maxNotes: 8, model: null, reviewTimeoutSec: 600 },
        sandboxDir: await mkdtemp(join(tmpdir(), 'pr-lens-live-')),
        signal: new AbortController().signal,
        onProgress: (m) => progress.push(m),
        limit: createLimiter(2),
        budget: Number(process.env.PR_LENS_LIVE_BUDGET) || undefined,
      });

      const lineIds = new Set(
        diff.files.flatMap((f) => f.hunks.flatMap((h) => h.lines.map((l) => l.id))),
      );
      const report = {
        progress,
        chunks: a.chunks,
        merge: a.merge,
        failed: a.failedChunks,
        usage: a.usage,
        dropped: a.dropped,
        notes: a.notes.map(
          (n) =>
            `${n.severity} ${n.path}:${n.startLine} ${n.title}${n.repaired ? ' (repaired)' : ''}`,
        ),
      };
      await writeFile(join(tmpdir(), 'pr-lens-live-report.json'), JSON.stringify(report, null, 2));
      if (process.env.PR_LENS_LIVE_BUDGET) {
        expect(a.chunks).toBeGreaterThan(1);
        expect(a.merge).toBe('model');
      }
      expect(a.failedChunks).toBe(0);
      expect(a.notes.length).toBeLessThanOrEqual(8);
      for (const n of a.notes) if (!n.fileLevel) expect(lineIds.has(n.startLineId)).toBe(true);
    },
    20 * 60_000,
  );
});
