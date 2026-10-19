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

const setup = async (paths: Partial<Record<LspLanguage, string>>, fail: LspLanguage[] = []) => {
  const worktree = await mkdtemp(join(tmpdir(), 'pr-lens-impact-wt-'));
  const git = {
    treeEntries: async () => [
      { path: 'cmd/main.go', oid: 'a'.repeat(40) },
      { path: 'app/views.py', oid: 'b'.repeat(40) },
    ],
    sourceFiles: async () => [],
    worktree: vi.fn(async () => worktree),
  } as unknown as GitService;
  const loaded = {
    target: {
      key: 'k',
      subject: { kind: 'pr', ref: { owner: 'o', repo: 'r', number: 1 } },
      headSha: HEAD,
    },
    diff,
  } as unknown as LoadedTarget;
  const review = { loaded: () => loaded } as unknown as ReviewService;
  const putImpact = vi.fn(async () => undefined);
  const cache = { getImpact: async () => null, putImpact } as unknown as AnalysisCache;
  const run = vi.fn(async ({ language }: { language: LspLanguage }) => {
    if (fail.includes(language)) throw new Error('gopls took too long and was stopped.');
    return map(language);
  });
  const service = createImpactService({
    git,
    review,
    cache,
    analyze: async () => map('ts'),
    servers: { paths: () => paths, run },
  });
  return { service, run, putImpact, git, worktree };
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
});
