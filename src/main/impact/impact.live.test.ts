import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DiffModel } from '../../shared/diff';
import { execFileRunner } from '../exec/exec';
import { createToolchain } from '../exec/toolchain';
import { createGit } from '../git/git';
import { analyzeImpact } from './analysis';
import { isConfigPath, isImpactSource } from './changes';

/**
 * Live check of the impact path against GitHub and git (no gh writes, no claude):
 *   PR_LENS_LIVE=1 pnpm test impact.live
 */
describe.skipIf(!process.env.PR_LENS_LIVE)('live impact map', () => {
  it('reads a blobless snapshot in bulk and maps callers of a changed function', async () => {
    const toolchain = createToolchain(execFileRunner, () => ({ ghPath: null, claudePath: null }));
    const dir = await mkdtemp(join(tmpdir(), 'pr-lens-live-impact-'));
    const git = createGit(execFileRunner, toolchain, {
      repos: join(dir, 'git'),
      worktrees: join(dir, 'wt'),
    });
    const repo = { owner: 'ungarscool1', repo: 'pr-lens' };
    const sha = '501e3959d3bf25ca9a0663c6de7eb7c7d84b85cb';
    const tree = await git.treeEntries(repo, sha);
    const read = await git.sourceFiles(
      repo,
      sha,
      tree.filter((entry) => isImpactSource(entry.path) || isConfigPath(entry.path)),
    );
    const gitTs = read.find((file) => file.path === 'src/main/git/git.ts');
    expect(gitTs?.text).toContain('export function credentialArgs');
    expect(read.length).toBeGreaterThan(80);

    // Pretend the first line of credentialArgs' body changed.
    const line =
      (gitTs?.text.split('\n').findIndex((l) => l.includes('function credentialArgs')) ?? 0) + 2;
    const diff: DiffModel = {
      files: [
        {
          fid: 'F1',
          path: 'src/main/git/git.ts',
          status: 'modified',
          binary: false,
          additions: 1,
          deletions: 0,
          noise: null,
          hunks: [{ header: '@@', lines: [{ id: 'F1-001', kind: 'add', new: line, text: '' }] }],
        },
      ],
    };
    const map = analyzeImpact({
      sources: read.filter((file) => isImpactSource(file.path)),
      configs: read.filter((file) => isConfigPath(file.path)),
      diff,
      skippedFiles: 0,
    });
    const changed = map.nodes.find((node) => node.changed);
    expect(changed?.name).toBe('credentialArgs');
    const callers = map.edges.filter((e) => e.to === changed?.id).map((e) => e.from);
    expect(callers.map((id) => map.nodes.find((n) => n.id === id)?.name)).toEqual(
      expect.arrayContaining(['withRepo']),
    );
  }, 300_000);
});
