import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { AppError } from '../../shared/errors';
import type { DiffModel } from '../../shared/diff';
import type { ImpactLanguage, ImpactMap } from '../../shared/impact';
import { LSP_LANGUAGES, LspLanguage, lspLanguageOf } from '../../shared/lsp';
import { repoOf } from '../../shared/subject';
import type { RepoRef } from '../../shared/subject';
import type { GitService, TreeEntry } from '../git/git';
import type { AnalysisCache } from '../review/cache';
import type { ReviewService } from '../review/service';
import type { ImpactInput } from './analysis';
import { stripExecutableBits } from './checkout';
import {
  ANALYZER_VERSION,
  changedLines,
  isConfigPath,
  isGitHubActionsPath,
  isImpactSource,
  isTestPath,
} from './changes';
import { analyzeGitHubActions } from './github-actions';
import { analyzeTerraformImpact, isTerraformSource } from './terraform';

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
  /** Language servers the user set up in Settings, and how to run one over a checkout. */
  servers: {
    paths: () => Partial<Record<LspLanguage, string>>;
    run: (run: {
      language: LspLanguage;
      command: string;
      root: string;
      diff: DiffModel;
      scannedFiles: number;
    }) => Promise<ImpactMap>;
  };
}

const isMappable = (path: string): boolean =>
  isImpactSource(path) ||
  isGitHubActionsPath(path) ||
  isTerraformSource(path) ||
  lspLanguageOf(path) !== null;

/** A stored map is reused only by the same analyzers and servers for the same changed lines. */
export function impactKey(
  diff: DiffModel,
  servers: Partial<Record<LspLanguage, string>> = {},
): string {
  const lines = [...changedLines(diff, isMappable)].map(([path, changed]) => [
    path,
    changed.map((c) => `${c.line}:${c.lineId}`),
  ]);
  const configured = LspLanguage.options.map((language) => servers[language] ?? null);
  return createHash('sha1')
    .update(JSON.stringify([ANALYZER_VERSION, configured, lines]))
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
  languages: [],
};

/** One map from the built-in TypeScript analysis and each language server's. */
export function mergeMaps(parts: ImpactMap[], languages: ImpactLanguage[]): ImpactMap {
  return {
    nodes: parts.flatMap((part) => part.nodes),
    edges: parts.flatMap((part) => part.edges),
    imports: parts.flatMap((part) => part.imports),
    tests: parts.flatMap((part) => part.tests),
    scannedFiles: parts.reduce((sum, part) => sum + part.scannedFiles, 0),
    skippedFiles: parts.reduce((sum, part) => sum + part.skippedFiles, 0),
    omittedChanged: parts.reduce((sum, part) => sum + part.omittedChanged, 0),
    languages,
  };
}

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

export function createImpactService({ git, review, cache, analyze, servers }: Deps): ImpactService {
  const running = new Map<string, Promise<ImpactMap>>();

  /** Language servers read from disk: a checkout of the head with nothing executable in it. */
  const checkout = async (repo: RepoRef, sha: string): Promise<string> => {
    const path = await git.worktree(
      repo,
      sha,
      `impact__${repo.owner}__${repo.repo}__${sha.slice(0, 12)}`,
    );
    await stripExecutableBits(path);
    return realpath(path);
  };

  const typescript = async (
    repo: RepoRef,
    headSha: string,
    diff: DiffModel,
    tree: TreeEntry[],
  ): Promise<ImpactMap> => {
    const configs = tree.filter((entry) => isConfigPath(entry.path));
    const candidates = prioritize(
      tree.filter((entry) => isImpactSource(entry.path)),
      new Set(changedLines(diff).keys()),
    ).slice(0, MAX_CANDIDATE_FILES);
    const read = await git.sourceFiles(repo, headSha, [...configs, ...candidates]);
    const configPaths = new Set(configs.map((entry) => entry.path));
    const sources = read.filter((file) => !configPaths.has(file.path));
    return analyze({
      sources,
      configs: read.filter((file) => configPaths.has(file.path)),
      diff,
      skippedFiles: tree.filter((entry) => isImpactSource(entry.path)).length - sources.length,
    });
  };

  const terraform = async (
    repo: RepoRef,
    headSha: string,
    diff: DiffModel,
    tree: TreeEntry[],
  ): Promise<ImpactMap> => {
    const candidates = prioritize(
      tree.filter((entry) => isTerraformSource(entry.path)),
      new Set(changedLines(diff, isTerraformSource).keys()),
    ).slice(0, MAX_CANDIDATE_FILES);
    const sources = await git.sourceFiles(repo, headSha, candidates);
    return analyzeTerraformImpact({
      sources,
      diff,
      skippedFiles: tree.filter((entry) => isTerraformSource(entry.path)).length - sources.length,
    });
  };

  const load = async (targetKey: string): Promise<ImpactMap> => {
    const loaded = review.loaded(targetKey);
    if (!loaded) throw new AppError('BAD_INPUT', 'Open it again before building an impact map.');
    const { subject, headSha } = loaded.target;
    const { diff } = loaded;
    const tsChanged = changedLines(diff).size > 0;
    const actionsChanged = changedLines(diff, isGitHubActionsPath).size > 0;
    const terraformChanged = changedLines(diff, isTerraformSource).size > 0;
    const lspChanged = LspLanguage.options.filter(
      (language) =>
        changedLines(diff, (path) => LSP_LANGUAGES[language].extensions.test(path)).size > 0,
    );
    if (!tsChanged && !actionsChanged && !terraformChanged && !lspChanged.length) return EMPTY;
    const paths = servers.paths();
    const key = impactKey(diff, paths);
    const stored = await cache.getImpact(subject, headSha, key);
    if (stored) return stored;

    const repo = repoOf(subject);
    const tree = await git.treeEntries(repo, headSha);
    const parts: ImpactMap[] = [];
    const languages: ImpactLanguage[] = [];
    if (tsChanged) {
      parts.push(await typescript(repo, headSha, diff, tree));
      languages.push({
        language: 'typescript',
        label: 'TypeScript / JavaScript',
        status: 'mapped',
        detail: 'built in',
      });
    }
    if (actionsChanged) {
      const definitions = tree.filter((entry) => isGitHubActionsPath(entry.path));
      const sources = await git.sourceFiles(
        repo,
        headSha,
        prioritize(definitions, new Set(changedLines(diff, isGitHubActionsPath).keys())).slice(
          0,
          MAX_CANDIDATE_FILES,
        ),
      );
      parts.push(
        analyzeGitHubActions({
          sources,
          diff,
          skippedFiles: definitions.length - sources.length,
        }),
      );
      languages.push({
        language: 'github-actions',
        label: 'GitHub Actions',
        status: 'mapped',
        detail: 'local workflow and action references',
      });
    }
    if (terraformChanged) {
      parts.push(await terraform(repo, headSha, diff, tree));
      languages.push({
        language: 'terraform',
        label: 'Terraform',
        status: 'mapped',
        detail: 'built in',
      });
    }
    let root: string | null = null;
    for (const language of lspChanged) {
      const info = LSP_LANGUAGES[language];
      const command = paths[language];
      if (!command) {
        languages.push({
          language,
          label: info.label,
          status: 'off',
          detail: `Set the path to ${info.server} in Settings to map these changes.`,
        });
        continue;
      }
      try {
        root ??= await checkout(repo, headSha);
        parts.push(
          await servers.run({
            language,
            command,
            root,
            diff,
            scannedFiles: tree.filter((entry) => info.extensions.test(entry.path)).length,
          }),
        );
        languages.push({
          language,
          label: info.label,
          status: 'mapped',
          detail: basename(command),
        });
      } catch (err) {
        languages.push({
          language,
          label: info.label,
          status: 'failed',
          detail: err instanceof Error ? err.message : `${info.server} failed.`,
        });
      }
    }
    const map = mergeMaps(parts, languages);
    // A server that failed may work next time (it was busy, or the path was just fixed).
    if (!languages.some((language) => language.status === 'failed'))
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
