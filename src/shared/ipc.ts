import { z } from 'zod';
import type { DiffModel } from './diff';
import type { Health } from './health';
import { CreateNoteInput, DeleteNoteInput, NoteId, PatchNoteStateInput } from './notes';
import type { NotesFile, PrivateNote } from './notes';
import { PrInput } from './pr';
import type { PrMeta } from './pr';
import type { Analysis, CacheInfo, Estimate, ReleaseSummary } from './review';
import { DiffMode, GitRefName, RepoRef, Subject, TargetKey } from './subject';
import type { CompareMeta, RefSuggestion, Target } from './subject';
import { OAuthTokenInput, SettingsPatch } from './settings';
import type { SettingsView } from './settings';

export type Header = { kind: 'pr'; meta: PrMeta } | { kind: 'compare'; meta: CompareMeta };

/** A PR or compare range, loaded and ready to review. */
export interface OpenResult {
  target: Target;
  header: Header;
  diff: DiffModel;
  estimate: Estimate;
  /** A finished analysis for this exact head SHA, from the on-disk cache, if one exists. */
  analysis: Analysis | null;
  cache: CacheInfo | null;
  /** Compare ranges only: a cached release summary. */
  release: ReleaseSummary | null;
}

/** What "Promote to comment" would post; nothing is written until confirm. */
export interface PromotePreview {
  confirmToken: string;
  pr: string;
  headSha: string;
  /** The gh account the comment would come from. */
  viewer: string;
  path: string;
  side: 'LEFT' | 'RIGHT';
  startLine: number;
  endLine: number;
  fileLevel: boolean;
  /** A pending review exists and the comment joins it; otherwise one is started. */
  pendingReviewExists: boolean;
  body: string;
}

export const CompareInput = RepoRef.extend({
  base: GitRefName,
  head: GitRefName,
  mode: DiffMode,
}).strict();
export type CompareInput = z.infer<typeof CompareInput>;

/**
 * Every invoke channel: its payload schema (validated in main) and its result type.
 * `output` is a type carrier only; results come from main and are not re-validated.
 */
export const contract = {
  'health:check': { input: z.undefined(), output: z.custom<Health>() },
  'settings:get': { input: z.undefined(), output: z.custom<SettingsView>() },
  'settings:update': { input: SettingsPatch, output: z.custom<SettingsView>() },
  'settings:setOAuthToken': { input: OAuthTokenInput, output: z.custom<SettingsView>() },
  'github:openPr': {
    input: z.object({ input: PrInput }).strict(),
    output: z.custom<OpenResult>(),
  },
  'github:openCompare': { input: CompareInput, output: z.custom<OpenResult>() },
  'github:searchRefs': {
    input: RepoRef.extend({
      query: z
        .string()
        .max(100)
        .regex(/^[A-Za-z0-9._/+@-]*$/),
    }).strict(),
    output: z.custom<{ defaultBranch: string | null; refs: RefSuggestion[] }>(),
  },
  'review:start': {
    input: z
      .object({
        targetKey: TargetKey,
        force: z.boolean(),
        kind: z.enum(['review', 'release']).default('review'),
      })
      .strict(),
    output: z.custom<{ jobId: string }>(),
  },
  'review:cancel': {
    input: z.object({ jobId: z.string().uuid() }).strict(),
    output: z.custom<void>(),
  },
  'notes:list': { input: z.object({ subject: Subject }).strict(), output: z.custom<NotesFile>() },
  'notes:create': { input: CreateNoteInput, output: z.custom<PrivateNote>() },
  'notes:delete': { input: DeleteNoteInput, output: z.custom<void>() },
  'notes:patchState': { input: PatchNoteStateInput, output: z.custom<void>() },
  'deepDive:open': {
    input: z.object({ targetKey: TargetKey, noteId: NoteId }).strict(),
    output: z.custom<{ worktreePath: string; scriptPath: string; terminalApp: string }>(),
  },
  'promote:preview': {
    input: z.object({ targetKey: TargetKey, noteId: NoteId }).strict(),
    output: z.custom<PromotePreview>(),
  },
  'promote:confirm': {
    input: z
      .object({ confirmToken: z.string().uuid(), body: z.string().min(1).max(65_000) })
      .strict(),
    output: z.custom<{ url: string | null }>(),
  },
  'shell:openExternal': {
    input: z.object({ url: z.string().max(2000) }).strict(),
    output: z.custom<void>(),
  },
} as const;

export type Contract = typeof contract;
export type Channel = keyof Contract;
export type Input<C extends Channel> = z.input<Contract[C]['input']>;
export type Output<C extends Channel> = z.output<Contract[C]['output']>;

/** Main → renderer push channel. */
export const REVIEW_EVENT_CHANNEL = 'review:event';
