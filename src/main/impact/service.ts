import { createHash } from 'node:crypto';
import { AppError } from '../../shared/errors';
import type { DiffModel } from '../../shared/diff';
import type { ImpactMap } from '../../shared/impact';
import { repoOf } from '../../shared/subject';
import type { GitService, TreeEntry } from '../git/git';
import type { AnalysisCache } from '../review/cache';
import type { ReviewService } from '../review/service';
import type { ImpactInput } from './analysis';
import {
  ANALYZER_VERSION,
  changedLines,
  isConfigPath,
  isImpactSource,
  isTestPath,
} from './changes';

const MAX_CANDIDATE_FILES = 1_200;

export interface ImpactService {
  get(targetKey: string): Promise<ImpactMap>;
}

interface Deps {
  git: GitService;
  review: ReviewService;
  cache: AnalysisCache;
  /** Runs `analyzeImpact`; production passes the worker thread so the main process stays responsive. */
  analyze: (input: ImpactInput) => Promise<ImpactMap>;
}

/** A stored map is reused only by the same analyzer for the same changed lines. */
export function impactKey(diff: DiffModel): string {
  const lines = [...changedLines(diff)].map(([path, changed]) => [
    path,
    changed.map((c) => `${c.line}:${c.lineId}`),
  ]);
  return createHash('sha1')
    .update(JSON.stringify([ANALYZER_VERSION, lines]))
    .digest('hex')
    .slice(0, 16);
}

const EMPTY: ImpactMap = {
  nodes: [],
  edges: [],
  imports: [],
  tests: [],
  scannedFiles: 0,
  skippedFiles: 0,
  omittedChanged: 0,
};

/**
 * Changed files first, then their neighbours by directory, then tests, so the bounded set most
 * likely holds the callers.
 */
export function prioritize(entries: TreeEntry[], changed: ReadonlySet<string>): TreeEntry[] {
  const prefix = (path: string, depth: number): string => path.split('/').slice(0, depth).join('/');
  const near2 = new Set([...changed].map((path) => prefix(path, 2)));
  const near1 = new Set([...changed].map((path) => prefix(path, 1)));
  const rank = (path: string): number =>
    changed.has(path)
      ? 0
      : near2.has(prefix(path, 2))
        ? 1
        : near1.has(prefix(path, 1))
          ? 2
          : isTestPath(path)
            ? 3
            : 4;
  return [...entries].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
}

export function createImpactService({ git, review, cache, analyze }: Deps): ImpactService {
  const running = new Map<string, Promise<ImpactMap>>();

  const load = async (targetKey: string): Promise<ImpactMap> => {
    const loaded = review.loaded(targetKey);
    if (!loaded) throw new AppError('BAD_INPUT', 'Open it again before building an impact map.');
    const { subject, headSha } = loaded.target;
    const changed = changedLines(loaded.diff);
    if (!changed.size) return EMPTY;
    const key = impactKey(loaded.diff);
    const stored = await cache.getImpact(subject, headSha, key);
    if (stored) return stored;

    const repo = repoOf(subject);
    const tree = await git.treeEntries(repo, headSha);
    const configs = tree.filter((entry) => isConfigPath(entry.path));
    const candidates = prioritize(
      tree.filter((entry) => isImpactSource(entry.path)),
      new Set(changed.keys()),
    ).slice(0, MAX_CANDIDATE_FILES);
    const read = await git.sourceFiles(repo, headSha, [...configs, ...candidates]);
    const configPaths = new Set(configs.map((entry) => entry.path));
    const sources = read.filter((file) => !configPaths.has(file.path));
    const map = await analyze({
      sources,
      configs: read.filter((file) => configPaths.has(file.path)),
      diff: loaded.diff,
      skippedFiles: tree.filter((entry) => isImpactSource(entry.path)).length - sources.length,
    });
    await cache.putImpact(subject, headSha, key, map);
    return map;
  };

  return {
    get(targetKey) {
      const existing = running.get(targetKey);
      if (existing) return existing;
      const result = load(targetKey).finally(() => running.delete(targetKey));
      running.set(targetKey, result);
      return result;
    },
  };
}
