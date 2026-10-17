import { AppError } from '../../shared/errors';
import type { ImpactMap } from '../../shared/impact';
import { repoOf } from '../../shared/subject';
import type { GitService } from '../git/git';
import type { ReviewService } from '../review/service';
import { analyzeImpact, isImpactSource } from './analysis';

const MAX_CANDIDATE_FILES = 1_200;
const isTestPath = (path: string): boolean =>
  /(?:^|\/)(?:__tests__|test|tests)\/|\.(?:test|spec)\.(?:cts|mts|ts|tsx)$/i.test(path);

export interface ImpactService {
  get(targetKey: string): Promise<ImpactMap>;
}

export function createImpactService(git: GitService, review: ReviewService): ImpactService {
  const cache = new Map<string, Promise<ImpactMap>>();

  const load = async (targetKey: string): Promise<ImpactMap> => {
    const loaded = review.loaded(targetKey);
    if (!loaded) throw new AppError('BAD_INPUT', 'Open it again before building an impact map.');
    const all = (await git.treePaths(repoOf(loaded.target.subject), loaded.target.headSha)).filter(
      isImpactSource,
    );
    const changed = new Set(
      loaded.diff.files.filter((file) => isImpactSource(file.path)).map((file) => file.path),
    );
    // Changed code and tests are retained first; the rest stays path-stable for predictable maps.
    const paths = [...all].sort(
      (a, b) =>
        Number(changed.has(b)) - Number(changed.has(a)) ||
        Number(isTestPath(b)) - Number(isTestPath(a)) ||
        a.localeCompare(b),
    );
    const selected = paths.slice(0, MAX_CANDIDATE_FILES);
    const sources = await git.sourceFiles(
      repoOf(loaded.target.subject),
      loaded.target.headSha,
      selected,
    );
    return analyzeImpact({
      sources,
      diff: loaded.diff,
      skippedFiles: all.length - sources.length,
    });
  };

  return {
    get(targetKey) {
      const existing = cache.get(targetKey);
      if (existing) return existing;
      const result = load(targetKey);
      cache.set(targetKey, result);
      void result.catch(() => cache.delete(targetKey));
      return result;
    },
  };
}
