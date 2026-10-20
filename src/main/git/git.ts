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
   * A detached checkout of `sha` named `name` under the worktrees dir, created or reused by
   * automatic reviews, deep dives and language servers.
   * The least recently used ones beyond the limit are removed.
   */
  worktree(repo: RepoRef, sha: string, name: string): Promise<string>;
  /** Lists tracked files at one commit (path and blob ID) without checking them out. */
  treeEntries(repo: RepoRef, sha: string): Promise<TreeEntry[]>;
  /**
   * Reads files at one commit, in the given order until the byte bounds are reached. Blobs the
   * blobless cache does not hold yet are fetched in one request, not one per file.
   */
  sourceFiles(
    repo: RepoRef,
    sha: string,
    entries: TreeEntry[],
  ): Promise<{ path: string; text: string }[]>;
  /**
   * Reads named files at one commit, with the same bounds as `sourceFiles`. A path that is
   * missing, binary or too large is left out of the result.
   */
  filesAt(repo: RepoRef, sha: string, paths: string[]): Promise<{ path: string; text: string }[]>;
}

export interface TreeEntry {
  path: string;
  oid: string;
}

export interface GitDirs {
  /** Bare cache repos, one per GitHub repo. */
  repos: string;
  /** Detached worktrees for repository-aware features. */
  worktrees: string;
}

const SHA = /^[0-9a-f]{40}$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const NAME = /^[A-Za-z0-9._-]{1,200}$/;
const TREE_PATH = /^(?!-)(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n]+$/;
export const MAX_WORKTREES = 10;
const MAX_SOURCE_FILE_BYTES = 512 * 1024;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;

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

/** `ls-tree -z` output; submodules (commit) and symlinks are not files to read. */
const parseTree = (output: string): TreeEntry[] =>
  output.split('\0').flatMap((line) => {
    // `<mode> <type> <oid>\t<path>`
    const match = /^100(?:644|755) blob ([0-9a-f]+)\t(.+)$/s.exec(line);
    return match?.[1] && match[2] && OID.test(match[1]) && TREE_PATH.test(match[2])
      ? [{ path: match[2], oid: match[1] }]
      : [];
  });

type Run = (
  args: string[],
  timeoutMs: number,
  opts?: { input?: string; encoding?: 'utf8' | 'latin1' },
) => Promise<string>;

interface RepoCtx {
  run: Run;
  bare: string;
  cred: string[];
  url: string;
}

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
    return async (args, timeoutMs, opts) => {
      const r = await exec({
        file: git,
        args,
        env,
        timeoutMs,
        maxBufferBytes: 256 * 1024 * 1024,
        ...opts,
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
  };

  /** Ensures the bare cache repo exists and fetches `shas` into it, then runs `fn` under its lock. */
  const withRepo = <T>(
    repo: RepoRef,
    shas: string[],
    why: string,
    fn: (ctx: RepoCtx) => Promise<T>,
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
      return fn({ run, bare, cred, url });
    });
  };

  /**
   * Reads blobs of one commit, in order until the byte bounds are reached. Blobs the blobless
   * cache does not hold yet are fetched in one request, not one per file.
   */
  const readBlobs = async (
    { run, bare, cred, url }: RepoCtx,
    sha: string,
    entries: TreeEntry[],
  ): Promise<{ path: string; text: string }[]> => {
    const wanted = entries.filter((e) => OID.test(e.oid) && TREE_PATH.test(e.path));
    const oids = [...new Set(wanted.map((e) => e.oid))];
    if (!oids.length) return [];
    // `--missing=print` lists what the blobless fetch left on GitHub without fetching it.
    const listed = await run(
      ['-C', bare, 'rev-list', '--objects', '--missing=print', sha],
      120_000,
    );
    const missing = new Set(
      listed
        .split('\n')
        .filter((line) => line.startsWith('?'))
        .map((line) => line.slice(1).split(' ')[0]),
    );
    const fetch = oids.filter((oid) => missing.has(oid));
    if (fetch.length) {
      // The same request git makes for one lazily fetched blob, for all of them at once.
      await run(
        [
          '-C',
          bare,
          ...cred,
          'fetch',
          '--quiet',
          '--no-tags',
          '--no-write-fetch-head',
          '--recurse-submodules=no',
          '--filter=blob:none',
          '--stdin',
          url,
        ],
        300_000,
        { input: `${fetch.join('\n')}\n` },
      );
    }

    const sizes = new Map<string, number>();
    const checked = await run(['-C', bare, 'cat-file', '--batch-check'], 120_000, {
      input: `${oids.join('\n')}\n`,
    });
    for (const line of checked.split('\n')) {
      const [oid, type, size] = line.split(' ');
      if (oid && type === 'blob') sizes.set(oid, Number(size));
    }
    const chosen = new Set<string>();
    let usedBytes = 0;
    for (const { oid } of wanted) {
      const size = sizes.get(oid);
      if (chosen.has(oid) || size === undefined || size > MAX_SOURCE_FILE_BYTES) continue;
      if (usedBytes + size > MAX_SOURCE_BYTES) break;
      usedBytes += size;
      chosen.add(oid);
    }
    if (!chosen.size) return [];

    // latin1 keeps one char per byte, so each blob is cut out by its byte size.
    const output = await run(['-C', bare, 'cat-file', '--batch'], 120_000, {
      input: `${[...chosen].join('\n')}\n`,
      encoding: 'latin1',
    });
    const texts = new Map<string, string>();
    for (let pos = 0; pos < output.length;) {
      const end = output.indexOf('\n', pos);
      if (end < 0) break;
      const [oid, type, sizeText] = output.slice(pos, end).split(' ');
      pos = end + 1;
      const size = Number(sizeText);
      if (!oid || type !== 'blob' || !Number.isSafeInteger(size)) continue;
      const raw = output.slice(pos, pos + size);
      pos += size + 1;
      if (!raw.includes('\0')) texts.set(oid, Buffer.from(raw, 'latin1').toString('utf8'));
    }
    return wanted.flatMap(({ path, oid }) => {
      const text = texts.get(oid);
      return text === undefined ? [] : [{ path, text }];
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
      return withRepo(repo, [sha], 'Repository context', async ({ run, bare, cred }) => {
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

    treeEntries: (repo, sha) =>
      withRepo(repo, [sha], 'Impact map', async ({ run, bare }) => {
        const output = await run(['-C', bare, 'ls-tree', '-r', '-z', sha], 120_000);
        return parseTree(output);
      }),

    sourceFiles: (repo, sha, entries) =>
      withRepo(repo, [sha], 'Impact map', (ctx) => readBlobs(ctx, sha, entries)),

    filesAt: (repo, sha, paths) =>
      withRepo(repo, [sha], 'Expanding the diff', async (ctx) => {
        const valid = paths.filter((p) => TREE_PATH.test(p));
        if (!valid.length) return [];
        // Literal pathspecs: a path like `:(glob)*` names a file, never a pattern.
        const output = await ctx.run(
          ['--literal-pathspecs', '-C', ctx.bare, 'ls-tree', '-z', sha, '--', ...valid],
          60_000,
        );
        return readBlobs(ctx, sha, parseTree(output));
      }),
  };
}
