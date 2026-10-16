import { createHash } from 'node:crypto';
import { z } from 'zod';
import { subjectSlug } from '../../shared/subject';
import type { Subject } from '../../shared/subject';
import {
  Analysis,
  MERGE_PROMPT_VERSION,
  PROMPT_VERSION,
  ReleaseSummary,
} from '../../shared/review';
import type { Settings } from '../../shared/settings';
import type { JsonStore } from '../store/json-store';

/** Bump when the stored shape changes; older files are then treated as a miss. */
const CACHE_VERSION = 1;

const CacheFile = z.object({
  version: z.literal(CACHE_VERSION),
  settingsKey: z.string(),
  analysis: Analysis,
});

export interface CachedAnalysis {
  analysis: Analysis;
  /** Made with other prompts, model, note cap or noise globs than the current settings. */
  stale: boolean;
}

export interface AnalysisCache {
  get(subject: Subject, headSha: string, settings: CacheSettings): Promise<CachedAnalysis | null>;
  put(subject: Subject, analysis: Analysis, settings: CacheSettings): Promise<void>;
  getRelease(subject: Subject, headSha: string): Promise<ReleaseSummary | null>;
  putRelease(subject: Subject, headSha: string, release: ReleaseSummary): Promise<void>;
}

const ReleaseFile = z.object({ version: z.literal(CACHE_VERSION), release: ReleaseSummary });

export type CacheSettings = Pick<Settings, 'model' | 'maxNotes' | 'noiseGlobs'>;

/** Everything besides the head SHA that changes what a review would say. */
export function settingsKey(s: CacheSettings): string {
  const parts = [
    PROMPT_VERSION,
    MERGE_PROMPT_VERSION,
    s.model ?? '',
    s.maxNotes,
    [...s.noiseGlobs].sort().join('\n'),
  ];
  return createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 16);
}

const SHA = /^[0-9a-f]{7,64}$/;

// ponytail: no pruning. One small JSON file per reviewed head SHA under userData; add an LRU
// or age limit if this directory ever gets big.
const fileFor = (s: Subject, headSha: string): string => {
  if (!SHA.test(headSha)) throw new Error('Refusing a non-SHA cache key');
  return `analyses/${subjectSlug(s)}/${headSha}.json`;
};
const releaseFileFor = (s: Subject, headSha: string): string =>
  fileFor(s, headSha).replace(/\.json$/, '.release.json');

/**
 * One analysis per (subject, head SHA): a PR at one push, or one compare range. A hit made with different settings is still
 * returned, flagged stale: a paid-for review is never thrown away silently.
 */
export function createAnalysisCache(store: JsonStore): AnalysisCache {
  return {
    async get(subject, headSha, settings) {
      const name = fileFor(subject, headSha);
      let file: z.infer<typeof CacheFile> | null;
      try {
        file = await store.read(name, CacheFile.nullable(), null);
      } catch (err) {
        // Unreadable or from an older version: a miss, and the next run overwrites it.
        // Log the error name only: a JSON parse message can quote file content (diff text).
        console.warn(
          `[cache] ignoring unreadable analysis for ${subjectSlug(subject)}:`,
          err instanceof Error ? err.name : 'unknown error',
        );
        return null;
      }
      if (!file) return null;
      return { analysis: file.analysis, stale: file.settingsKey !== settingsKey(settings) };
    },
    put: (subject, analysis, settings) =>
      store.write(fileFor(subject, analysis.headSha), {
        version: CACHE_VERSION,
        settingsKey: settingsKey(settings),
        analysis,
      }),
    async getRelease(subject, headSha) {
      const name = releaseFileFor(subject, headSha);
      try {
        return (await store.read(name, ReleaseFile.nullable(), null))?.release ?? null;
      } catch (err) {
        console.warn(
          `[cache] ignoring unreadable release summary for ${subjectSlug(subject)}:`,
          err instanceof Error ? err.name : 'unknown error',
        );
        return null;
      }
    },
    putRelease: (subject, headSha, release) =>
      store.write(releaseFileFor(subject, headSha), { version: CACHE_VERSION, release }),
  };
}
