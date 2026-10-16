import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors';
import type { DiffModel } from '../../shared/diff';
import type { OpenPrResult } from '../../shared/ipc';
import { parsePrInput, targetKey } from '../../shared/pr';
import type { PrMeta, Target } from '../../shared/pr';
import type { Estimate, ReviewEvent } from '../../shared/review';
import { buildDiffModel } from '../diff/parse';
import type { GitHubClient } from '../github/gh';
import type { SettingsService } from '../settings/settings';
import type { AnalysisCache } from './cache';
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
  cache: AnalysisCache;
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
      const hit = await deps.cache.get(ref, meta.headSha, deps.settings.current());
      return {
        target,
        meta,
        diff,
        estimate: estimate(loaded),
        analysis: hit?.analysis ?? null,
        cache: hit ? { from: 'cache', stale: hit.stale, saved: true } : null,
      };
    },

    start(key, force) {
      const loaded = targets.get(key);
      if (!loaded)
        throw new AppError('BAD_INPUT', 'Open the pull request again before reviewing it.');
      const jobId = randomUUID();
      const ctrl = new AbortController();
      jobs.set(jobId, ctrl);
      const base = { jobId, targetKey: key };

      queueMicrotask(() => {
        deps.emit({ ...base, type: 'started' });
        void (async () => {
          try {
            // Settings are read once, so the cache key matches what the run actually used.
            const settings = deps.settings.current();
            const hit = force
              ? null
              : await deps.cache.get(loaded.target.ref, loaded.target.headSha, settings);
            if (hit) {
              deps.emit({
                ...base,
                type: 'done',
                analysis: hit.analysis,
                cache: { from: 'cache', stale: hit.stale, saved: true },
              });
              return;
            }
            const analysis = await runReviewPipeline(deps.claude, {
              ...loaded,
              settings,
              sandboxDir: deps.sandboxDir,
              budget: deps.chunkBudget,
              signal: ctrl.signal,
              limit,
              onProgress: (message) => deps.emit({ ...base, type: 'progress', message }),
            });
            const saved = await deps.cache.put(loaded.target.ref, analysis, settings).then(
              () => true,
              (err: unknown) => {
                // The review itself succeeded; show it, and say it was not saved.
                console.warn(
                  '[cache] could not save analysis:',
                  err instanceof Error ? err.name : 'unknown error',
                );
                return false;
              },
            );
            deps.emit({
              ...base,
              type: 'done',
              analysis,
              cache: { from: 'run', stale: false, saved },
            });
          } catch (err) {
            deps.emit({ ...base, type: 'error', error: AppError.from(err).toJSON() });
          } finally {
            jobs.delete(jobId);
          }
        })();
      });
      return { jobId };
    },

    cancel(jobId) {
      jobs.get(jobId)?.abort();
    },
  };
}
