import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors';
import type { DiffModel } from '../../shared/diff';
import type { OpenPrResult } from '../../shared/ipc';
import { parsePrInput, targetKey } from '../../shared/pr';
import type { PrMeta, Target } from '../../shared/pr';
import type { Analysis, Estimate, ReviewEvent } from '../../shared/review';
import { buildDiffModel } from '../diff/parse';
import type { GitHubClient } from '../github/gh';
import type { SettingsService } from '../settings/settings';
import type { ClaudeClient } from './claude';
import { createLimiter } from './limiter';
import { runReviewPipeline } from './pipeline';
import { planReview } from './plan';

export interface ReviewService {
  openPr(input: string): Promise<OpenPrResult>;
  start(targetKey: string, force: boolean): { jobId: string };
  cancel(jobId: string): void;
}

interface Deps {
  github: GitHubClient;
  claude: ClaudeClient;
  settings: SettingsService;
  sandboxDir: string;
  emit: (e: ReviewEvent) => void;
  /** Chunk budget override; only set in development (PR_LENS_CHUNK_BUDGET). */
  chunkBudget?: number;
}

// At most this many claude processes at once, across every job (chunks included).
const MAX_CONCURRENT_CLAUDE = 2;

interface LoadedTarget {
  target: Target;
  meta: PrMeta;
  diff: DiffModel;
}

export function createReviewService(deps: Deps): ReviewService {
  const targets = new Map<string, LoadedTarget>();
  // ponytail: in-memory only. Phase 3 persists analyses per (repo, PR, head SHA) on disk.
  const analyses = new Map<string, Analysis>();
  const jobs = new Map<string, AbortController>();
  const limit = createLimiter(MAX_CONCURRENT_CLAUDE);

  const estimate = (l: LoadedTarget): Estimate => {
    try {
      const plan = planReview(
        l.target.ref,
        l.meta,
        l.diff,
        deps.settings.current().maxNotes,
        deps.chunkBudget,
      );
      return {
        inputTokens: plan.estimatedTokens,
        chunks: plan.prompts.length,
        secrets: plan.redactions,
        blocked: null,
      };
    } catch (err) {
      const e = AppError.from(err);
      if (e.code !== 'PR_TOO_LARGE') throw e;
      return { inputTokens: 0, chunks: 0, secrets: [], blocked: e.message };
    }
  };

  return {
    async openPr(input) {
      const ref = parsePrInput(input);
      if (!ref) {
        throw new AppError(
          'BAD_INPUT',
          'Enter a PR URL (github.com/owner/repo/pull/123) or owner/repo#123.',
        );
      }
      const [meta, diffText] = await Promise.all([
        deps.github.prMeta(ref),
        deps.github.prDiff(ref),
      ]);
      const diff = buildDiffModel(diffText, deps.settings.current().noiseGlobs);
      const target: Target = { key: targetKey(ref, meta.headSha), ref, headSha: meta.headSha };
      const loaded = { target, meta, diff };
      targets.set(target.key, loaded);
      return {
        target,
        meta,
        diff,
        estimate: estimate(loaded),
        analysis: analyses.get(target.key) ?? null,
      };
    },

    start(key, force) {
      const loaded = targets.get(key);
      if (!loaded)
        throw new AppError('BAD_INPUT', 'Open the pull request again before reviewing it.');
      const jobId = randomUUID();
      const cached = analyses.get(key);
      const ctrl = new AbortController();
      jobs.set(jobId, ctrl);
      queueMicrotask(() => {
        deps.emit({ jobId, targetKey: key, type: 'started' });
        if (cached && !force) {
          deps.emit({ jobId, targetKey: key, type: 'done', analysis: cached });
          jobs.delete(jobId);
          return;
        }
        runReviewPipeline(deps.claude, {
          ...loaded,
          settings: deps.settings.current(),
          sandboxDir: deps.sandboxDir,
          budget: deps.chunkBudget,
          signal: ctrl.signal,
          limit,
          onProgress: (message) => deps.emit({ jobId, targetKey: key, type: 'progress', message }),
        })
          .then((analysis) => {
            analyses.set(key, analysis);
            deps.emit({ jobId, targetKey: key, type: 'done', analysis });
          })
          .catch((err: unknown) =>
            deps.emit({ jobId, targetKey: key, type: 'error', error: AppError.from(err).toJSON() }),
          )
          .finally(() => jobs.delete(jobId));
      });
      return { jobId };
    },

    cancel(jobId) {
      jobs.get(jobId)?.abort();
    },
  };
}
