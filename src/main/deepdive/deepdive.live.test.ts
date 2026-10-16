import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execFileRunner } from '../exec/exec';
import { createToolchain } from '../exec/toolchain';
import { createGit } from '../git/git';

/**
 * Live check of deep-dive worktrees against real gh + git (no terminal, no claude):
 *   PR_LENS_LIVE=1 pnpm test deepdive.live
 */
describe.skipIf(!process.env.PR_LENS_LIVE)('live worktree', () => {
  it('checks out a PR head detached, then reuses it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pr-lens-live-wt-'));
    const toolchain = createToolchain(execFileRunner, () => ({ ghPath: null, claudePath: null }));
    const git = createGit(execFileRunner, toolchain, {
      repos: join(dir, 'git'),
      worktrees: join(dir, 'wt'),
    });
    // cli/cli#9000's head commit: a PR head is fetchable by SHA from the base repo.
    const sha = 'cc36d32a212a2b8b6611fb73549fe6d04fb6ec38';
    const path = await git.worktree(
      { owner: 'cli', repo: 'cli' },
      sha,
      'cli__cli__pr9000__cc36d32',
    );
    expect(path).toBe(join(dir, 'wt', 'cli__cli__pr9000__cc36d32'));
    expect(await readFile(join(path, 'go.mod'), 'utf8')).toContain('module github.com/cli/cli');
    const t0 = Date.now();
    expect(
      await git.worktree({ owner: 'cli', repo: 'cli' }, sha, 'cli__cli__pr9000__cc36d32'),
    ).toBe(path);
    expect(Date.now() - t0).toBeLessThan(3_000); // reused, not fetched again
    expect(await readdir(join(dir, 'wt'))).toEqual(['cli__cli__pr9000__cc36d32']);
  }, 600_000);
});
