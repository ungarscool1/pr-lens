import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors';
import type { DiffModel } from '../../shared/diff';
import type { CompareInput, Header, OpenResult } from '../../shared/ipc';
import { parsePrInput } from '../../shared/pr';
import type { Estimate, ReviewEvent } from '../../shared/review';
import { repoOf, targetKeyOf, worktreeName } from '../../shared/subject';
import type { CompareMeta, Subject, Target } from '../../shared/subject';
import { buildDiffModel } from '../diff/parse';
import type { GitService } from '../git/git';
import type { GitHubClient } from '../github/gh';
import type { SettingsService } from '../settings/settings';
import type { AnalysisCache } from './cache';
import type { ClaudeClient } from './claude';
import { createLimiter } from './limiter';
import { runReviewPipeline } from './pipeline';
import { planReview } from './plan';
import { compareContext, prContext } from './prompt';
import type { PromptContext } from './prompt';
import { runRelease } from './release';

export type JobKind = 'review' | 'release';

export interface ReviewService {
  openPr(input: string): Promise<OpenResult>;
  openCompare(input: CompareInput): Promise<OpenResult>;
  start(targetKey: string, force: boolean, kind: JobKind): { jobId: string };
  cancel(jobId: string): void;
  /** A target opened in this session, for features that build on it (deep dive). */
  loaded(targetKey: string): LoadedTarget | undefined;
}

interface Deps {
  github: GitHubClient;
  git: GitService;
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

export interface LoadedTarget {
  target: Target;
  header: Header;
  context: PromptContext;
  diff: DiffModel;
}

export function createReviewService(deps: Deps): ReviewService {
  const targets = new Map<string, LoadedTarget>();
  const jobs = new Map<string, AbortController>();
  const limit = createLimiter(MAX_CONCURRENT_CLAUDE);

  const estimate = (l: LoadedTarget): Estimate => {
    try {
      const plan = planReview(
        l.context,
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

  /** Registers a loaded target and attaches whatever the cache already has for it. */
  const finishOpen = async (
    subject: Subject,
    headSha: string,
    header: Header,
    context: PromptContext,
    diffText: string,
  ): Promise<OpenResult> => {
    const target: Target = { key: targetKeyOf(subject, headSha), subject, headSha };
    const diff = buildDiffModel(diffText, deps.settings.current().noiseGlobs);
    const loaded = { target, header, context, diff };
    targets.set(target.key, loaded);
    const [hit, release] = await Promise.all([
      deps.cache.get(subject, headSha, deps.settings.current()),
      subject.kind === 'compare' ? deps.cache.getRelease(subject, headSha) : Promise.resolve(null),
    ]);
    return {
      target,
      header,
      diff,
      estimate: estimate(loaded),
      analysis: hit?.analysis ?? null,
      cache: hit ? { from: 'cache', stale: hit.stale, saved: true } : null,
      release,
    };
  };

  const runJob = async (
    loaded: LoadedTarget,
    kind: JobKind,
    force: boolean,
    base: { jobId: string; targetKey: string },
    signal: AbortSignal,
  ): Promise<void> => {
    // Settings are read once, so the cache key matches what the run actually used.
    const settings = deps.settings.current();
    const { subject, headSha } = loaded.target;
    const save = (p: Promise<void>): Promise<boolean> =>
      p.then(
        () => true,
        (err: unknown) => {
          // The result itself is good; show it, and say it was not saved.
          console.warn(
            '[cache] could not save:',
            err instanceof Error ? err.name : 'unknown error',
          );
          return false;
        },
      );

    if (kind === 'release') {
      if (subject.kind !== 'compare')
        throw new AppError('BAD_INPUT', 'Release summaries are for compare ranges.');
      const cached = force ? null : await deps.cache.getRelease(subject, headSha);
      if (cached) {
        deps.emit({ ...base, type: 'release', release: cached, cached: true });
        return;
      }
      deps.emit({ ...base, type: 'progress', message: 'Writing the release summary…' });
      const review = await deps.cache.get(subject, headSha, settings);
      const release = await runRelease(deps.claude, {
        ...loaded,
        notes: review?.analysis.notes ?? [],
        settings,
        sandboxDir: deps.sandboxDir,
        signal,
        limit,
      });
      await save(deps.cache.putRelease(subject, headSha, release));
      deps.emit({ ...base, type: 'release', release, cached: false });
      return;
    }

    const hit = force ? null : await deps.cache.get(subject, headSha, settings);
    if (hit) {
      deps.emit({
        ...base,
        type: 'done',
        analysis: hit.analysis,
        cache: { from: 'cache', stale: hit.stale, saved: true },
      });
      return;
    }
    deps.emit({ ...base, type: 'progress', message: 'Preparing repository context…' });
    const repositoryDir = await deps.git.worktree(
      repoOf(subject),
      headSha,
      worktreeName(subject, headSha),
    );
    if (signal.aborted) throw new AppError('CANCELLED');
    const analysis = await runReviewPipeline(deps.claude, {
      ...loaded,
      settings,
      sandboxDir: deps.sandboxDir,
      repositoryDir,
      budget: deps.chunkBudget,
      signal,
      limit,
      onProgress: (message) => deps.emit({ ...base, type: 'progress', message }),
    });
    const saved = await save(deps.cache.put(subject, analysis, settings));
    deps.emit({ ...base, type: 'done', analysis, cache: { from: 'run', stale: false, saved } });
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
      return finishOpen(
        { kind: 'pr', ref },
        meta.headSha,
        { kind: 'pr', meta },
        prContext(ref, meta),
        diffText,
      );
    },

    async openCompare({ owner, repo, base, head, mode }) {
      const r = { owner, repo };
      const [baseSha, headSha, tags] = await Promise.all([
        deps.github.resolveCommit(r, base),
        deps.github.resolveCommit(r, head),
        deps.github.tagsAmong(r, [base, head]),
      ]);
      const info = await deps.github.compare(r, baseSha, headSha);
      // When base is an ancestor of head, the merge base is base itself: both diffs are equal,
      // and GitHub's three-dot diff serves both without touching git.
      const diffText =
        mode === 'three-dot' || info.behindBy === 0
          ? await deps.github.compareDiff(r, baseSha, headSha)
          : await deps.git.directDiff(r, baseSha, headSha);
      const meta: CompareMeta = {
        owner,
        repo,
        base,
        head,
        mode,
        baseSha,
        headSha,
        ...info,
        baseIsTag: tags.has(base),
        headIsTag: tags.has(head),
      };
      // Identical diffs share one subject, so switching modes does not pay for a second review.
      const sameDiff = info.behindBy === 0;
      const subject: Subject = {
        kind: 'compare',
        owner,
        repo,
        baseSha,
        headSha,
        mode: sameDiff ? 'three-dot' : mode,
      };
      return finishOpen(
        subject,
        headSha,
        { kind: 'compare', meta },
        compareContext(meta),
        diffText,
      );
    },

    start(key, force, kind) {
      const loaded = targets.get(key);
      if (!loaded) throw new AppError('BAD_INPUT', 'Open it again before reviewing it.');
      const jobId = randomUUID();
      const ctrl = new AbortController();
      jobs.set(jobId, ctrl);
      const base = { jobId, targetKey: key };
      queueMicrotask(() => {
        deps.emit({ ...base, type: 'started' });
        runJob(loaded, kind, force, base, ctrl.signal)
          .catch((err: unknown) =>
            deps.emit({ ...base, type: 'error', error: AppError.from(err).toJSON() }),
          )
          .finally(() => jobs.delete(jobId));
      });
      return { jobId };
    },

    cancel(jobId) {
      jobs.get(jobId)?.abort();
    },

    loaded: (key) => targets.get(key),
  };
}
