import { createHash } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
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
  /** Removes old cache heads, retaining a bounded number of the most recently written entries. */
  prune(): Promise<void>;
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
export const ANALYSIS_CACHE_MAX_ENTRIES = 200;
export const ANALYSIS_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
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
/** `analysesDir` is passed in production; omitting it keeps this cache usable in isolated tests. */
export function createAnalysisCache(store: JsonStore, analysesDir?: string): AnalysisCache {
  const prune = async (): Promise<void> => {
    if (!analysesDir) return;
    const subjects = await readdir(analysesDir, { withFileTypes: true }).catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return [];
        throw err;
      },
    );
    const entries = await Promise.all(
      subjects
        .filter((subject) => subject.isDirectory())
        .map(async (subject) => {
          const dir = join(analysesDir, subject.name);
          const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
          const heads = new Map<string, { paths: string[]; mtime: number }>();
          await Promise.all(
            files
              .filter((file) => file.isFile())
              .map(async (file) => {
                const match = /^(?<sha>[a-f0-9]{7,64})(?:\.release)?\.json$/.exec(file.name);
                if (!match?.groups?.sha) return;
                const path = join(dir, file.name);
                try {
                  const mtime = (await stat(path)).mtimeMs;
                  const head = heads.get(match.groups.sha) ?? { paths: [], mtime };
                  head.paths.push(path);
                  head.mtime = Math.max(head.mtime, mtime);
                  heads.set(match.groups.sha, head);
                } catch {
                  // The file changed concurrently; leave it for a later prune.
                }
              }),
          );
          return [...heads.values()];
        }),
    );
    const cutoff = Date.now() - ANALYSIS_CACHE_MAX_AGE_MS;
    const ordered = entries.flat().sort((a, b) => b.mtime - a.mtime);
    const discarded = ordered.filter((entry) => entry.mtime < cutoff || ordered.indexOf(entry) >= ANALYSIS_CACHE_MAX_ENTRIES);
    await Promise.all(discarded.flatMap((entry) => entry.paths.map((path) => rm(path, { force: true }))));
  };

  const pruneQuietly = async (): Promise<void> => {
    try {
      await prune();
    } catch (err) {
      console.warn('[cache] could not prune:', err instanceof Error ? err.name : 'unknown error');
    }
  };
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
    async put(subject, analysis, settings) {
      await store.write(fileFor(subject, analysis.headSha), {
        version: CACHE_VERSION,
        settingsKey: settingsKey(settings),
        analysis,
      });
      await pruneQuietly();
    },
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
    async putRelease(subject, headSha, release) {
      await store.write(releaseFileFor(subject, headSha), { version: CACHE_VERSION, release });
      await pruneQuietly();
    },
    prune: pruneQuietly,
  };
}
