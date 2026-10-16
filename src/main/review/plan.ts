import { AppError } from '../../shared/errors';
import type { DiffModel } from '../../shared/diff';
import type { PrMeta, PrRef } from '../../shared/pr';
import type { SecretFinding } from '../../shared/review';
import { planChunks } from './chunker';
import { buildReviewPrompt } from './prompt';
import type { BuiltPrompt } from './prompt';

/** Input-token budget for one chunk's whole prompt (header, manifest, diff, task). */
export const CHUNK_BUDGET_TOKENS = 90_000;
/** More chunks than this is refused: it would take long and cost a lot for one review. */
export const MAX_CHUNKS = 8;
// Rough size of the merge pass per chunk (summaries and candidates), for the estimate only.
const MERGE_TOKENS_PER_CHUNK = 1_500;

export interface ReviewPlan {
  prompts: BuiltPrompt[];
  estimatedTokens: number;
  redactions: SecretFinding[];
}

/** One prompt per chunk. A PR that fits one budget is sent whole, as a single pass. */
export function planReview(
  ref: PrRef,
  meta: PrMeta,
  diff: DiffModel,
  maxNotes: number,
  budget = CHUNK_BUDGET_TOKENS,
): ReviewPlan {
  const whole = buildReviewPrompt(ref, meta, diff, maxNotes);
  if (whole.estimatedTokens <= budget) {
    return {
      prompts: [whole],
      estimatedTokens: whole.estimatedTokens,
      redactions: whole.redactions,
    };
  }

  // What every chunk repeats: PR header, manifest, task.
  const overhead = buildReviewPrompt(ref, meta, diff, maxNotes, {
    index: 0,
    total: 2,
    items: [],
  }).estimatedTokens;
  const room = budget - overhead;
  if (room < budget / 4) {
    throw new AppError(
      'PR_TOO_LARGE',
      'The PR description and file list alone fill most of a review chunk.',
    );
  }
  const chunks = planChunks(diff, room);
  if (chunks.length > MAX_CHUNKS) {
    throw new AppError(
      'PR_TOO_LARGE',
      `This PR needs ${chunks.length} review chunks; PR Lens stops at ${MAX_CHUNKS}. Add noise globs for generated files in Settings, or review it on GitHub.`,
    );
  }
  const prompts = chunks.map((c, index) =>
    buildReviewPrompt(ref, meta, diff, maxNotes, { index, total: chunks.length, items: c.items }),
  );
  return {
    prompts,
    estimatedTokens:
      prompts.reduce((n, p) => n + p.estimatedTokens, 0) +
      (prompts.length > 1 ? prompts.length * MERGE_TOKENS_PER_CHUNK : 0),
    redactions: dedupeFindings(prompts.flatMap((p) => p.redactions)),
  };
}

/** The header is repeated in every chunk, so its findings would repeat too. */
export function dedupeFindings(findings: readonly SecretFinding[]): SecretFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const k = `${f.lineId ?? ''}:${f.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
