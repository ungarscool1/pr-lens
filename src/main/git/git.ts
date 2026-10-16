import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../../shared/errors';
import type { RepoRef } from '../../shared/subject';
import type { Exec } from '../exec/exec';
import { gitEnv } from '../exec/toolchain';
import type { ToolchainService } from '../exec/toolchain';

export interface GitService {
  /**
   * Two-dot (direct) diff of two commits. GitHub's compare API only does three-dot, so this
   * fetches just those two commits (depth 1, no blobs up front) into a bare cache repo and
   * lets git pull the blobs it needs while diffing.
   */
  directDiff(repo: RepoRef, baseSha: string, headSha: string): Promise<string>;
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * Credentials for private repos come from `gh auth git-credential`. git runs a `!` helper
 * through a shell, so the gh path must be free of quoting characters; otherwise only public
 * repos work.
 */
export function credentialArgs(ghPath: string | null): string[] {
  if (!ghPath || /["'`$\\\s]/.test(ghPath)) return ['-c', 'credential.helper='];
  return ['-c', 'credential.helper=', '-c', `credential.helper=!"${ghPath}" auth git-credential`];
}

export function createGit(exec: Exec, toolchain: ToolchainService, cacheDir: string): GitService {
  // Fetches into one bare repo must not overlap (shallow and pack locks).
  const locks = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (locks.get(key) ?? Promise.resolve()).then(fn);
    locks.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  };

  return {
    directDiff(repo, baseSha, headSha) {
      if (!SHA.test(baseSha) || !SHA.test(headSha))
        throw new AppError('BAD_INPUT', 'Expected full commit SHAs.');
      const dir = join(cacheDir, repo.owner, `${repo.repo}.git`);
      return serial(dir, async () => {
        const tc = await toolchain.get();
        if (!tc.git) {
          throw new AppError(
            'BIN_NOT_FOUND',
            'Direct (two-dot) diffs need git. Install it (xcode-select --install or brew install git), or use merge-base.',
          );
        }
        const git = tc.git;
        const env = gitEnv(tc);
        const run = async (args: string[], timeoutMs: number): Promise<string> => {
          const r = await exec({
            file: git,
            args,
            env,
            timeoutMs,
            maxBufferBytes: 256 * 1024 * 1024,
          });
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

        if (
          !(await stat(dir).then(
            () => true,
            () => false,
          ))
        ) {
          await mkdir(dir, { recursive: true, mode: 0o700 });
          await run(['init', '--bare', '--quiet', dir], 30_000);
        }
        const url = `https://github.com/${repo.owner}/${repo.repo}.git`;
        await run(
          [
            '-C',
            dir,
            ...credentialArgs(tc.gh),
            'fetch',
            '--quiet',
            '--depth=1',
            '--filter=blob:none',
            '--no-tags',
            url,
            baseSha,
            headSha,
          ],
          300_000,
        );
        return run(
          // The filtered fetch registered the URL as a promisor remote; diff fetches blobs from it.
          [
            '-C',
            dir,
            ...credentialArgs(tc.gh),
            'diff',
            '--no-color',
            '--no-ext-diff',
            '-M',
            baseSha,
            headSha,
          ],
          300_000,
        );
      });
    },
  };
}
