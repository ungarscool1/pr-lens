import { z } from 'zod';
import type { SerializedError } from './errors';

export const PROMPT_VERSION = 'review.v2';

export const Severity = z.enum(['high', 'medium', 'low']);
export type Severity = z.infer<typeof Severity>;

export const Risk = z.enum(['high', 'medium', 'low', 'none']);
export type Risk = z.infer<typeof Risk>;

export const Category = z.enum([
  'behavior_change',
  'security',
  'concurrency',
  'api_break',
  'data_migration',
  'error_handling',
  'missing_tests',
  'performance',
  'correctness',
  'config',
  'other',
]);
export type Category = z.infer<typeof Category>;

export const CATEGORY_LABELS: Record<Category, string> = {
  behavior_change: 'Behavior change',
  security: 'Security',
  concurrency: 'Concurrency',
  api_break: 'API break',
  data_migration: 'Data migration',
  error_handling: 'Error handling',
  missing_tests: 'Missing tests',
  performance: 'Performance',
  correctness: 'Correctness',
  config: 'Config',
  other: 'Other',
};

// ID patterns are loose on purpose (`F2-03` passes) so one padding slip does not fail the
// whole response; strict normalization happens in validation.
const FILE_ID = z.string().regex(/^F[0-9]+$/i);
const LINE_ID = z.string().regex(/^F[0-9]+-[0-9]+$/i);

/** What the model must return (`--json-schema`). Single source for the JSON Schema too. */
export const ModelOutput = z
  .object({
    summary: z.string().max(700),
    files: z.array(z.object({ file: FILE_ID, risk: Risk, why: z.string().max(140) }).strict()),
    reading_order: z.array(FILE_ID),
    notes: z
      .array(
        z
          .object({
            key: z.string().regex(/^n[0-9]+$/),
            anchor: z.object({ file: FILE_ID, start: LINE_ID, end: LINE_ID }).strict(),
            quote: z.string().min(4).max(160),
            severity: Severity,
            category: Category,
            title: z.string().max(90),
            explanation: z.string().max(900),
            question: z.string().max(280).optional(),
            refs: z.array(z.string().regex(/^[CTF][0-9]+(-[0-9]+)?$/i)).optional(),
            confidence: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type ModelOutput = z.infer<typeof ModelOutput>;
export type ModelNote = ModelOutput['notes'][number];

export const MERGE_PROMPT_VERSION = 'merge.v1';

/**
 * Big PRs: what the merge pass returns. It never invents anchors: every final note cites
 * the candidate keys (`c2.n1`) it combines and inherits the first one's anchor.
 */
export const MergeOutput = z
  .object({
    summary: ModelOutput.shape.summary,
    files: ModelOutput.shape.files,
    reading_order: ModelOutput.shape.reading_order,
    notes: z
      .array(
        z
          .object({
            from: z.array(z.string().regex(/^c[0-9]+\.n[0-9]+$/i)).min(1),
            severity: Severity,
            category: Category,
            title: z.string().max(90),
            explanation: z.string().max(900),
            question: z.string().max(280).optional(),
            confidence: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type MergeOutput = z.infer<typeof MergeOutput>;

// Analysis types are zod schemas: an analysis is written to disk and read back (phase 3), and
// what comes back from disk is checked like any other input.

/** A model note after its line IDs were checked and resolved to real lines. */
export const AiNote = z.object({
  id: z.string(),
  source: z.literal('ai'),
  fid: z.string(),
  path: z.string(),
  side: z.enum(['LEFT', 'RIGHT']),
  /** Empty for file-level notes. */
  startLineId: z.string(),
  endLineId: z.string(),
  /** 0 for file-level notes. */
  startLine: z.number().int(),
  endLine: z.number().int(),
  /** The model named a shown file but no line in it that could be found. */
  fileLevel: z.boolean(),
  severity: Severity,
  category: Category,
  title: z.string(),
  body: z.string(),
  question: z.string().optional(),
  refs: z.array(z.string()),
  confidence: z.number(),
  score: z.number(),
  repaired: z.boolean(),
});
export type AiNote = z.infer<typeof AiNote>;

export const DroppedNote = z.object({ key: z.string(), title: z.string(), reason: z.string() });
export type DroppedNote = z.infer<typeof DroppedNote>;

export const FileRisk = z.object({ fid: z.string(), risk: Risk, why: z.string() });
export type FileRisk = z.infer<typeof FileRisk>;

export const Usage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
});
export type Usage = z.infer<typeof Usage>;

export const SecretFinding = z.object({ lineId: z.string().nullable(), kind: z.string() });
export type SecretFinding = z.infer<typeof SecretFinding>;

export const Analysis = z.object({
  targetKey: z.string(),
  headSha: z.string(),
  promptVersion: z.string(),
  summary: z.string(),
  files: z.array(FileRisk),
  readingOrder: z.array(z.string()),
  notes: z.array(AiNote),
  dropped: z.array(DroppedNote),
  usage: Usage,
  chunks: z.number().int(),
  /** Chunks whose review failed; their files have no AI notes. */
  failedChunks: z.number().int(),
  /** How chunk results were combined: not needed, by the merge model pass, or by rules after it failed. */
  merge: z.enum(['none', 'model', 'fallback']),
  redactions: z.array(SecretFinding),
  createdAt: z.number(),
});
export type Analysis = z.infer<typeof Analysis>;

export interface Estimate {
  inputTokens: number;
  chunks: number;
  secrets: SecretFinding[];
  /** Why this PR cannot be reviewed as is (too many chunks), or null. */
  blocked: string | null;
}

/** Where the shown analysis came from. `stale`: cached with other settings; `saved`: on disk. */
export interface CacheInfo {
  from: 'cache' | 'run';
  stale: boolean;
  saved: boolean;
}

/** Every event names its target, so the renderer can match it before `start` has replied. */
export type ReviewEvent = { jobId: string; targetKey: string } & (
  | { type: 'started' }
  | { type: 'progress'; message: string }
  | { type: 'done'; analysis: Analysis; cache: CacheInfo }
  | { type: 'release'; release: ReleaseSummary; cached: boolean }
  | { type: 'error'; error: SerializedError }
);

export const RELEASE_PROMPT_VERSION = 'release.v1';

/** Tag-to-tag compares: a release summary. `risky` cites note IDs from the review, if one ran. */
export const ReleaseOutput = z
  .object({
    headline: z.string().max(160),
    changes: z
      .array(
        z
          .object({
            area: z.string().max(60),
            bullets: z.array(z.string().max(240)).min(1).max(8),
          })
          .strict(),
      )
      .max(12),
    risky: z.array(z.string().max(40)).max(10),
  })
  .strict();
export type ReleaseOutput = z.infer<typeof ReleaseOutput>;

export const ReleaseSummary = ReleaseOutput.extend({
  targetKey: z.string(),
  usage: Usage,
  createdAt: z.number(),
});
export type ReleaseSummary = z.infer<typeof ReleaseSummary>;
