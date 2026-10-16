import { z } from 'zod';
import type { DiffModel } from './diff';
import type { Health } from './health';
import { CreateNoteInput, DeleteNoteInput, PatchNoteStateInput } from './notes';
import type { NotesFile, PrivateNote } from './notes';
import { PrInput, PrRef, TargetKey } from './pr';
import type { PrMeta, Target } from './pr';
import type { Analysis, Estimate } from './review';
import { OAuthTokenInput, SettingsPatch } from './settings';
import type { SettingsView } from './settings';

export interface OpenPrResult {
  target: Target;
  meta: PrMeta;
  diff: DiffModel;
  estimate: Estimate;
  /** A finished analysis for this exact head SHA, if one exists. */
  analysis: Analysis | null;
}

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
    output: z.custom<OpenPrResult>(),
  },
  'review:start': {
    input: z.object({ targetKey: TargetKey, force: z.boolean() }).strict(),
    output: z.custom<{ jobId: string }>(),
  },
  'review:cancel': {
    input: z.object({ jobId: z.string().uuid() }).strict(),
    output: z.custom<void>(),
  },
  'notes:list': { input: z.object({ ref: PrRef }).strict(), output: z.custom<NotesFile>() },
  'notes:create': { input: CreateNoteInput, output: z.custom<PrivateNote>() },
  'notes:delete': { input: DeleteNoteInput, output: z.custom<void>() },
  'notes:patchState': { input: PatchNoteStateInput, output: z.custom<void>() },
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
