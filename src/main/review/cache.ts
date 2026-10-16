import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PrRef } from '../../shared/pr';
import { Analysis, MERGE_PROMPT_VERSION, PROMPT_VERSION } from '../../shared/review';
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
  get(ref: PrRef, headSha: string, settings: CacheSettings): Promise<CachedAnalysis | null>;
  put(ref: PrRef, analysis: Analysis, settings: CacheSettings): Promise<void>;
}

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
const fileFor = (r: PrRef, headSha: string): string => {
  if (!SHA.test(headSha)) throw new Error('Refusing a non-SHA cache key');
  return `analyses/${r.owner}__${r.repo}__${r.number}/${headSha}.json`;
};

/**
 * One analysis per (repo, PR, head SHA). A hit made with different settings is still
 * returned, flagged stale: a paid-for review is never thrown away silently.
 */
export function createAnalysisCache(store: JsonStore): AnalysisCache {
  return {
    async get(ref, headSha, settings) {
      const name = fileFor(ref, headSha);
      let file: z.infer<typeof CacheFile> | null;
      try {
        file = await store.read(name, CacheFile.nullable(), null);
      } catch (err) {
        // Unreadable or from an older version: a miss, and the next run overwrites it.
        // Log the error name only: a JSON parse message can quote file content (diff text).
        console.warn(
          `[cache] ignoring unreadable analysis for ${ref.owner}/${ref.repo}#${ref.number}:`,
          err instanceof Error ? err.name : 'unknown error',
        );
        return null;
      }
      if (!file) return null;
      return { analysis: file.analysis, stale: file.settingsKey !== settingsKey(settings) };
    },
    put: (ref, analysis, settings) =>
      store.write(fileFor(ref, analysis.headSha), {
        version: CACHE_VERSION,
        settingsKey: settingsKey(settings),
        analysis,
      }),
  };
}
