import { mkdir, readdir, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../../shared/errors';
import type { RepoRef } from '../../shared/subject';
import type { Exec } from '../exec/exec';
import { gitEnv } from '../exec/toolchain';
import type { Toolchain, ToolchainService } from '../exec/toolchain';

export interface GitService {
  /**
   * Two-dot (direct) diff of two commits. GitHub's compare API only does three-dot, so this
   * fetches just those two commits (depth 1, no blobs up front) into a bare cache repo and
   * lets git pull the blobs it needs while diffing.
   */
  directDiff(repo: RepoRef, baseSha: string, headSha: string): Promise<string>;
  /**
   * A detached checkout of `sha` named `name` under the worktrees dir, created or reused.
   * The least recently used ones beyond the limit are removed.
   */
  worktree(repo: RepoRef, sha: string, name: string): Promise<string>;
}

export interface GitDirs {
  /** Bare cache repos, one per GitHub repo. */
  repos: string;
  /** Detached worktrees for deep dives. */
  worktrees: string;
}

const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9._-]{1,200}$/;
export const MAX_WORKTREES = 10;

/**
 * Credentials for private repos come from `gh auth git-credential`. git runs a `!` helper
 * through a shell, so the gh path must be free of quoting characters; otherwise only public
 * repos work.
 */
export function credentialArgs(ghPath: string | null): string[] {
  if (!ghPath || /["'`$\\\s]/.test(ghPath)) return ['-c', 'credential.helper='];
  return ['-c', 'credential.helper=', '-c', `credential.helper=!"${ghPath}" auth git-credential`];
}

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

type Run = (args: string[], timeoutMs: number) => Promise<string>;

export function createGit(exec: Exec, toolchain: ToolchainService, dirs: GitDirs): GitService {
  // Work on one bare repo must not overlap (shallow and pack locks).
  const locks = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (locks.get(key) ?? Promise.resolve()).then(fn);
    locks.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  };

  const runner = (tc: Toolchain, git: string): Run => {
    const env = gitEnv(tc);
    return async (args, timeoutMs) => {
      const r = await exec({ file: git, args, env, timeoutMs, maxBufferBytes: 256 * 1024 * 1024 });
      if (r.code !== 0) {
        const first = r.stderr.trim().split('\n')[0]?.slice(0, 200) ?? '';
        if (
          /authentication|could not read username|terminal prompts disabled|403/i.test(r.stderr)
        ) {
          throw new AppError(
            'GH_NOT_AUTHENTICATED',
            'git could not fetch this repository. Run `gh auth login`, then retry.',
          );
        }
        throw new AppError('EXEC_FAILED', `git failed: ${first}`);
      }
      return r.stdout;
    };
  };

  /** Ensures the bare cache repo exists and fetches `shas` into it, then runs `fn` under its lock. */
  const withRepo = <T>(
    repo: RepoRef,
    shas: string[],
    why: string,
    fn: (ctx: { run: Run; bare: string; cred: string[] }) => Promise<T>,
  ): Promise<T> => {
    if (!shas.every((s) => SHA.test(s)))
      throw new AppError('BAD_INPUT', 'Expected full commit SHAs.');
    const bare = join(dirs.repos, repo.owner, `${repo.repo}.git`);
    return serial(bare, async () => {
      const tc = await toolchain.get();
      if (!tc.git)
        throw new AppError(
          'BIN_NOT_FOUND',
          `${why} needs git. Install it (xcode-select --install or brew install git).`,
        );
      const run = runner(tc, tc.git);
      const cred = credentialArgs(tc.gh);
      if (!(await exists(bare))) {
        await mkdir(bare, { recursive: true, mode: 0o700 });
        await run(['init', '--bare', '--quiet', bare], 30_000);
      }
      const url = `https://github.com/${repo.owner}/${repo.repo}.git`;
      // ponytail: depth 1, so no history in the worktree (no git log/blame); deepen if deep dives need it.
      await run(
        [
          '-C',
          bare,
          ...cred,
          'fetch',
          '--quiet',
          '--depth=1',
          '--filter=blob:none',
          '--no-tags',
          url,
          ...shas,
        ],
        300_000,
      );
      return fn({ run, bare, cred });
    });
  };

  /** Removes the least recently used worktrees beyond the limit (ours only, under dirs.worktrees). */
  const prune = async (run: Run, keep: string): Promise<void> => {
    const entries = await readdir(dirs.worktrees, { withFileTypes: true }).catch(() => []);
    const dated = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const p = join(dirs.worktrees, e.name);
          return { p, mtime: (await stat(p)).mtimeMs };
        }),
    );
    const old = dated
      .filter((d) => d.p !== keep)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(MAX_WORKTREES - 1);
    for (const { p } of old) {
      // git forgets the worktree; if that fails (already broken), the directory still goes.
      await run(['-C', p, 'worktree', 'remove', '--force', p], 60_000).catch(() => undefined);
      await rm(p, { recursive: true, force: true });
    }
  };

  return {
    directDiff: (repo, baseSha, headSha) =>
      withRepo(repo, [baseSha, headSha], 'Direct (two-dot) diffs', ({ run, bare, cred }) =>
        // The filtered fetch registered the URL as a promisor remote; diff fetches blobs from it.
        run(
          ['-C', bare, ...cred, 'diff', '--no-color', '--no-ext-diff', '-M', baseSha, headSha],
          300_000,
        ),
      ),

    async worktree(repo, sha, name) {
      if (!NAME.test(name)) throw new AppError('BAD_INPUT', 'Bad worktree name.');
      const path = join(dirs.worktrees, name);
      if (await exists(path)) {
        const tc = await toolchain.get();
        const head = tc.git
          ? await runner(tc, tc.git)(['-C', path, 'rev-parse', 'HEAD'], 10_000).catch(() => '')
          : '';
        if (head.trim() === sha) {
          const now = new Date();
          await utimes(path, now, now); // most recently used
          return path;
        }
        await rm(path, { recursive: true, force: true });
      }
      return withRepo(repo, [sha], 'Ask Claude', async ({ run, bare, cred }) => {
        await mkdir(dirs.worktrees, { recursive: true, mode: 0o700 });
        await run(['-C', bare, 'worktree', 'prune'], 30_000);
        // Checkout pulls the blobs of this one tree from the promisor remote.
        await run(
          ['-C', bare, ...cred, 'worktree', 'add', '--detach', '--quiet', path, sha],
          600_000,
        );
        await prune(run, path);
        return path;
      });
    },
  };
}
