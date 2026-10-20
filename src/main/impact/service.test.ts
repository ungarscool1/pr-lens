import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DiffFile, DiffModel } from '../../shared/diff';
import type { ImpactMap } from '../../shared/impact';
import type { LspLanguage } from '../../shared/lsp';
import type { GitService } from '../git/git';
import type { AnalysisCache } from '../review/cache';
import type { LoadedTarget, ReviewService } from '../review/service';
import type { SourceText } from './analysis';
import { createImpactService, impactKey } from './service';

const HEAD = 'c'.repeat(40);
const file = (fid: string, path: string): DiffFile => ({
  fid,
  path,
  status: 'modified',
  binary: false,
  additions: 1,
  deletions: 0,
  noise: null,
  hunks: [{ header: '@@', lines: [{ id: `${fid}-001`, kind: 'add', new: 1, text: 'x' }] }],
});
const diff: DiffModel = { files: [file('F1', 'cmd/main.go'), file('F2', 'app/views.py')] };

const map = (name: string): ImpactMap => ({
  nodes: [
    {
      id: `${name}#1`,
      name,
      kind: 'function',
      container: null,
      path: name,
      startLine: 1,
      endLine: 2,
      changed: true,
      test: false,
      anchorLineId: 'F1-001',
    },
  ],
  edges: [],
  imports: [],
  tests: [],
  scannedFiles: 1,
  skippedFiles: 0,
  omittedChanged: 0,
  languages: [],
});

const setup = async (
  paths: Partial<Record<LspLanguage, string>>,
  fail: LspLanguage[] = [],
  inputDiff: DiffModel = diff,
  sources: SourceText[] = [],
) => {
  const worktree = await mkdtemp(join(tmpdir(), 'pr-lens-impact-wt-'));
  const git = {
    treeEntries: async () => [
      { path: 'cmd/main.go', oid: 'a'.repeat(40) },
      { path: 'app/views.py', oid: 'b'.repeat(40) },
      ...sources.map((source) => ({ path: source.path, oid: 'd'.repeat(40) })),
    ],
    sourceFiles: vi.fn(async (_repo, _sha, entries: { path: string }[]) =>
      sources.filter((source) => entries.some((entry) => entry.path === source.path)),
    ),
    worktree: vi.fn(async () => worktree),
  } as unknown as GitService;
  const loaded = {
    target: {
      key: 'k',
      subject: { kind: 'pr', ref: { owner: 'o', repo: 'r', number: 1 } },
      headSha: HEAD,
    },
    diff: inputDiff,
  } as unknown as LoadedTarget;
  const review = { loaded: () => loaded } as unknown as ReviewService;
  const putImpact = vi.fn(async () => undefined);
  const getImpact = vi.fn(async (): Promise<ImpactMap | null> => null);
  const cache = { getImpact, putImpact } as unknown as AnalysisCache;
  const run = vi.fn(async ({ language }: { language: LspLanguage }) => {
    if (fail.includes(language)) throw new Error('gopls took too long and was stopped.');
    return map(language);
  });
  const analyze = vi.fn(async () => map('ts'));
  const service = createImpactService({
    git,
    review,
    cache,
    analyze,
    servers: { paths: () => paths, run },
  });
  return { service, run, putImpact, getImpact, analyze, git, worktree };
};

describe('impact service', () => {
  it('runs only the servers the user set, in one shared checkout, and says what is off', async () => {
    const { service, run, putImpact, git } = await setup({ go: '/u/gopls' });
    const result = await service.get('k');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      language: 'go',
      command: '/u/gopls',
      scannedFiles: 1,
    });
    expect(git.worktree).toHaveBeenCalledWith(
      { owner: 'o', repo: 'r' },
      HEAD,
      `impact__o__r__${HEAD.slice(0, 12)}`,
    );
    expect(result.nodes.map((node) => node.name)).toEqual(['go']);
    expect(result.languages).toEqual([
      { language: 'go', label: 'Go', status: 'mapped', detail: 'gopls' },
      expect.objectContaining({ language: 'python', status: 'off' }),
    ]);
    expect(putImpact).toHaveBeenCalledTimes(1);
  });

  it('reports a failed server without losing the others, and does not store that map', async () => {
    const { service, putImpact } = await setup({ go: '/u/gopls', python: '/u/pyright' }, ['go']);
    const result = await service.get('k');
    expect(result.nodes.map((node) => node.name)).toEqual(['python']);
    expect(result.languages.map((language) => [language.language, language.status])).toEqual([
      ['go', 'failed'],
      ['python', 'mapped'],
    ]);
    expect(putImpact).not.toHaveBeenCalled();
  });

  it('keys stored maps by the configured servers, so setting one up is a fresh map', () => {
    expect(impactKey(diff, {})).not.toBe(impactKey(diff, { go: '/u/gopls' }));
    expect(impactKey(diff, { go: '/u/gopls' })).toBe(impactKey(diff, { go: '/u/gopls' }));
  });

  it('maps an Actions-only diff without a TypeScript analysis, server or checkout', async () => {
    const action = { path: '.github/actions/build/action.yml', text: 'name: Build\nruns: {}' };
    const workflow = {
      path: '.github/workflows/ci.yml',
      text: 'jobs: { build: { steps: [{ uses: ./.github/actions/build }] } }',
    };
    const { service, analyze, run, git, getImpact, putImpact } = await setup(
      {},
      [],
      { files: [file('F1', action.path)] },
      [workflow, action],
    );
    const result = await service.get('k');
    expect(result.nodes.map((node) => [node.path, node.changed])).toEqual([
      [action.path, true],
      [workflow.path, false],
    ]);
    expect(result.edges).toEqual([{ from: `${workflow.path}#0`, to: `${action.path}#0` }]);
    expect(result.languages).toEqual([
      {
        language: 'github-actions',
        label: 'GitHub Actions',
        status: 'mapped',
        detail: 'local workflow and action references',
      },
    ]);
    expect(analyze).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(git.worktree).not.toHaveBeenCalled();
    expect(putImpact).toHaveBeenCalledTimes(1);
    expect(git.sourceFiles).toHaveBeenCalledWith({ owner: 'o', repo: 'r' }, HEAD, [
      expect.objectContaining({ path: action.path }),
      expect.objectContaining({ path: workflow.path }),
    ]);
    getImpact.mockResolvedValue(result);
    expect(await service.get('k')).toEqual(result);
    expect(git.sourceFiles).toHaveBeenCalledTimes(1);
  });

  it('merges GitHub Actions with language maps', async () => {
    const workflow = { path: '.github/workflows/ci.yaml', text: 'name: CI\njobs: {}' };
    const { service, analyze, run } = await setup(
      { go: '/u/gopls' },
      [],
      { files: [...diff.files, file('F3', 'src/main.ts'), file('F4', workflow.path)] },
      [workflow],
    );
    const result = await service.get('k');
    expect(result.nodes.map((node) => node.name)).toEqual(['ts', 'CI', 'go']);
    expect(result.languages.map((language) => [language.language, language.status])).toEqual([
      ['typescript', 'mapped'],
      ['github-actions', 'mapped'],
      ['go', 'mapped'],
      ['python', 'off'],
    ]);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keys maps by Actions changed lines and ignores unrelated YAML', () => {
    const workflow = file('F1', '.github/workflows/ci.yml');
    const action = file('F2', 'tools/build/action.yaml');
    const key = impactKey({ files: [workflow, action] });
    expect(key).not.toBe(impactKey({ files: [workflow] }));
    action.hunks[0]!.lines[0]!.new = 2;
    expect(key).not.toBe(impactKey({ files: [workflow, action] }));
    expect(impactKey({ files: [file('F1', 'config.yml')] })).toBe(impactKey({ files: [] }));
  });
});
