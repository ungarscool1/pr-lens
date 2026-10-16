import { z } from 'zod';
import type { Side } from './diff';
import type { SerializedError } from './errors';

export const PROMPT_VERSION = 'review.v1';

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

/** A model note after its line IDs were checked and resolved to real lines. */
export interface AiNote {
  id: string;
  source: 'ai';
  fid: string;
  path: string;
  side: Side;
  /** Empty for file-level notes. */
  startLineId: string;
  endLineId: string;
  /** 0 for file-level notes. */
  startLine: number;
  endLine: number;
  /** The model named a shown file but no line in it that could be found. */
  fileLevel: boolean;
  severity: Severity;
  category: Category;
  title: string;
  body: string;
  question?: string;
  refs: string[];
  confidence: number;
  score: number;
  repaired: boolean;
}

export interface DroppedNote {
  key: string;
  title: string;
  reason: string;
}

export interface FileRisk {
  fid: string;
  risk: Risk;
  why: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface SecretFinding {
  lineId: string | null;
  kind: string;
}

export interface Analysis {
  targetKey: string;
  headSha: string;
  promptVersion: string;
  summary: string;
  files: FileRisk[];
  readingOrder: string[];
  notes: AiNote[];
  dropped: DroppedNote[];
  usage: Usage;
  chunks: number;
  /** Chunks whose review failed; their files have no AI notes. */
  failedChunks: number;
  /** How chunk results were combined: not needed, by the merge model pass, or by rules after it failed. */
  merge: 'none' | 'model' | 'fallback';
  redactions: SecretFinding[];
  createdAt: number;
}

export interface Estimate {
  inputTokens: number;
  chunks: number;
  secrets: SecretFinding[];
  /** Why this PR cannot be reviewed as is (too many chunks), or null. */
  blocked: string | null;
}

/** Every event names its target, so the renderer can match it before `start` has replied. */
export type ReviewEvent = { jobId: string; targetKey: string } & (
  | { type: 'started' }
  | { type: 'progress'; message: string }
  | { type: 'done'; analysis: Analysis }
  | { type: 'error'; error: SerializedError }
);
