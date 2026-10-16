import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors';
import type { DiffModel } from '../../shared/diff';
import type { OpenPrResult } from '../../shared/ipc';
import { parsePrInput, targetKey } from '../../shared/pr';
import type { PrMeta, Target } from '../../shared/pr';
import { PROMPT_VERSION } from '../../shared/review';
import type { Analysis, ReviewEvent } from '../../shared/review';
import { buildDiffModel } from '../diff/parse';
import type { GitHubClient } from '../github/gh';
import type { SettingsService } from '../settings/settings';
import type { ClaudeClient } from './claude';
import { createLimiter } from './limiter';
import { buildReviewPrompt, SYSTEM_PROMPT } from './prompt';
import { rankNotes } from './rank';
import { validateModelOutput } from './validate';

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
}

// ponytail: single-pass only. Chunking big PRs by file/hunk arrives in phase 2; until then
// anything above this budget is refused instead of sent.
const SINGLE_PASS_MAX_TOKENS = 150_000;
const MAX_CONCURRENT_JOBS = 2;

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
  const limit = createLimiter(MAX_CONCURRENT_JOBS);

  const runJob = async (
    jobId: string,
    loaded: LoadedTarget,
    signal: AbortSignal,
  ): Promise<Analysis> => {
    const s = deps.settings.current();
    const { target, meta, diff } = loaded;
    const built = buildReviewPrompt(target.ref, meta, diff, s.maxNotes);
    if (built.estimatedTokens > SINGLE_PASS_MAX_TOKENS) throw new AppError('PR_TOO_LARGE');
    if (signal.aborted) throw new AppError('CANCELLED');
    deps.emit({
      jobId,
      targetKey: target.key,
      type: 'progress',
      message: 'Claude is reading the diff…',
    });

    const { output, usage } = await deps.claude.review({
      prompt: built.prompt,
      systemPrompt: SYSTEM_PROMPT,
      cwd: deps.sandboxDir,
      model: s.model,
      timeoutMs: s.reviewTimeoutSec * 1000,
      signal,
    });
    const valid = validateModelOutput(output, diff);
    const { kept, cut } = rankNotes(valid.notes, s.maxNotes);
    return {
      targetKey: target.key,
      headSha: target.headSha,
      promptVersion: PROMPT_VERSION,
      summary: output.summary,
      files: valid.files,
      readingOrder: valid.readingOrder,
      notes: kept,
      dropped: [...valid.dropped, ...cut],
      usage,
      chunks: 1,
      redactions: built.redactions,
      createdAt: Date.now(),
    };
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
      targets.set(target.key, { target, meta, diff });
      const built = buildReviewPrompt(ref, meta, diff, deps.settings.current().maxNotes);
      return {
        target,
        meta,
        diff,
        estimate: { inputTokens: built.estimatedTokens, secrets: built.redactions },
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
        limit(() => runJob(jobId, loaded, ctrl.signal))
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
