import { AppError } from '../../shared/errors';
import type { DiffModel } from '../../shared/diff';
import type { Target } from '../../shared/subject';
import { PROMPT_VERSION } from '../../shared/review';
import type { Analysis, DroppedNote, Usage } from '../../shared/review';
import type { Settings } from '../../shared/settings';
import type { ClaudeClient } from './claude';
import { applyMerge, buildMergePrompt, fallbackMerge, MERGE_SYSTEM_PROMPT } from './merge';
import type { Candidate, ChunkResult } from './merge';
import { planReview } from './plan';
import { SYSTEM_PROMPT } from './prompt';
import type { PromptContext } from './prompt';
import { rankNotes } from './rank';
import { completeReadingOrder, validateFiles, validateNotes, visibleAll } from './validate';
import type { ValidNote } from './validate';

export interface PipelineInput {
  target: Target;
  context: PromptContext;
  diff: DiffModel;
  settings: Pick<Settings, 'maxNotes' | 'model' | 'reviewTimeoutSec'>;
  sandboxDir: string;
  /** Detached checkout at the reviewed head, available to review passes as read-only context. */
  repositoryDir?: string;
  signal: AbortSignal;
  onProgress: (message: string) => void;
  /** Shared process limiter: at most N claude children across all jobs. */
  limit: <T>(task: () => Promise<T>) => Promise<T>;
  /** Chunk budget override (tests). */
  budget?: number;
}

const ZERO: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
});

/**
 * plan → review each chunk (two at a time) → validate each against what it was shown →
 * merge (model pass for several chunks, rules if that fails) → rank and cap.
 * A failed chunk makes the analysis partial; only all chunks failing fails the job.
 */
export async function runReviewPipeline(
  claude: ClaudeClient,
  input: PipelineInput,
): Promise<Analysis> {
  const { target, context, diff, settings, signal } = input;
  const plan = planReview(context, diff, settings.maxNotes, input.budget);
  const total = plan.prompts.length;
  const call = <T>(fn: () => Promise<T>): Promise<T> =>
    input.limit(() => (signal.aborted ? Promise.reject(new AppError('CANCELLED')) : fn()));
  const base = {
    cwd: input.sandboxDir,
    model: settings.model,
    timeoutMs: settings.reviewTimeoutSec * 1000,
    signal,
  };

  input.onProgress(total > 1 ? `Reviewing ${total} chunks…` : 'Claude is reading the diff…');
  let done = 0;
  const settled = await Promise.allSettled(
    plan.prompts.map((p) =>
      call(() =>
        claude.review({
          ...base,
          repositoryDir: input.repositoryDir,
          prompt: p.prompt,
          systemPrompt: SYSTEM_PROMPT,
        }),
      ).then((r) => {
        done++;
        if (total > 1) input.onProgress(`Reviewed ${done} of ${total} chunks…`);
        return r;
      }),
    ),
  );
  if (signal.aborted) throw new AppError('CANCELLED');

  let usage = ZERO;
  const candidates: Candidate[] = [];
  const chunkResults: ChunkResult[] = [];
  const dropped: DroppedNote[] = [];
  let failedChunks = 0;
  let firstError: unknown = null;

  settled.forEach((s, i) => {
    const prompt = plan.prompts[i];
    if (s.status === 'rejected' || !prompt) {
      failedChunks++;
      firstError ??= s.status === 'rejected' ? s.reason : null;
      return;
    }
    const { output, usage: u } = s.value;
    usage = addUsage(usage, u);
    const v = validateNotes(output.notes, diff, prompt.visible);
    const tag = total > 1 ? `c${i + 1}.` : '';
    dropped.push(...v.dropped.map((d) => ({ ...d, key: tag + d.key })));
    v.notes.forEach((note, j) => candidates.push({ key: `c${i + 1}.n${j + 1}`, note }));
    chunkResults.push({ summary: output.summary, ...validateFiles(output, prompt.visible) });
  });
  if (failedChunks === total) throw AppError.from(firstError);

  let notes: ValidNote[] = candidates.map((c) => c.note);
  let combined = fallbackMerge(chunkResults);
  let merge: Analysis['merge'] = 'none';

  if (total > 1 && candidates.length > 0) {
    input.onProgress('Merging chunk results…');
    try {
      const prompt = buildMergePrompt(context, diff, candidates, chunkResults, settings.maxNotes);
      const r = await call(() =>
        claude.merge({ ...base, prompt, systemPrompt: MERGE_SYSTEM_PROMPT }),
      );
      usage = addUsage(usage, r.usage);
      const applied = applyMerge(r.output, candidates);
      notes = applied.notes;
      dropped.push(...applied.dropped);
      combined = { summary: r.output.summary, ...validateFiles(r.output, visibleAll(diff)) };
      merge = 'model';
    } catch (err) {
      if (signal.aborted || (err instanceof AppError && err.code === 'CANCELLED'))
        throw new AppError('CANCELLED');
      // Chunk results are still good: combine them by rule rather than lose them.
      merge = 'fallback';
    }
  }

  const { kept, cut } = rankNotes(notes, settings.maxNotes);
  return {
    targetKey: target.key,
    headSha: target.headSha,
    promptVersion: PROMPT_VERSION,
    summary: combined.summary,
    files: combined.files,
    readingOrder: completeReadingOrder(combined.readingOrder, diff),
    notes: kept,
    dropped: [...dropped, ...cut],
    usage,
    chunks: total,
    failedChunks,
    merge,
    redactions: plan.redactions,
    createdAt: Date.now(),
  };
}
