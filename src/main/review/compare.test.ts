import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ReleaseOutput, ReviewEvent } from '../../shared/review';
import { Settings } from '../../shared/settings';
import { GitRefName, subjectSlug, TargetKey, targetKeyOf } from '../../shared/subject';
import type { Subject } from '../../shared/subject';
import { SAMPLE_DIFF } from '../diff/fixtures';
import type { Exec, ExecRequest } from '../exec/exec';
import type { ToolchainService } from '../exec/toolchain';
import { createGit, credentialArgs } from '../git/git';
import type { GitHubClient } from '../github/gh';
import type { SettingsService } from '../settings/settings';
import { createJsonStore } from '../store/json-store';
import { createAnalysisCache } from './cache';
import type { ClaudeClient } from './claude';
import { buildReleasePrompt, validateRelease } from './release';
import { createReviewService } from './service';
import { compareContext } from './prompt';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('GitRefName', () => {
  it.each(['main', 'feature/x-1', 'v1.4.0', 'release/2026.10', A, 'user@fix+1'])(
    'accepts %s',
    (r) => expect(GitRefName.safeParse(r).success).toBe(true),
  );
  it.each(['-rf', 'a..b', 'x//y', 'a@{1}', 'x y', 'a/', 'b.', 'x.lock', '', 'a;rm', 'a\nb'])(
    'rejects %j',
    (r) => expect(GitRefName.safeParse(r).success).toBe(false),
  );
});

describe('subject keys', () => {
  const compare: Subject = {
    kind: 'compare',
    owner: 'cli',
    repo: 'cli',
    baseSha: A,
    headSha: B,
    mode: 'two-dot',
  };
  it('builds keys that pass their own schema', () => {
    expect(TargetKey.safeParse(targetKeyOf(compare, B)).success).toBe(true);
    expect(targetKeyOf(compare, B)).toBe(`cli/cli@${A}..${B}`);
    expect(targetKeyOf({ ...compare, mode: 'three-dot' }, B)).toBe(`cli/cli@${A}...${B}`);
    const pr: Subject = { kind: 'pr', ref: { owner: 'acme', repo: 'api', number: 812 } };
    expect(TargetKey.safeParse(targetKeyOf(pr, B)).success).toBe(true);
  });
  it('gives PRs the same file slug as before, and compares a per-range one', () => {
    expect(subjectSlug({ kind: 'pr', ref: { owner: 'acme', repo: 'api', number: 812 } })).toBe(
      'acme__api__812',
    );
    expect(subjectSlug(compare)).toBe(
      `cli__cli__compare__2dot__${A.slice(0, 12)}__${B.slice(0, 12)}`,
    );
  });
});

describe('git', () => {
  it('uses gh as credential helper only when its path is shell-safe', () => {
    expect(credentialArgs('/opt/homebrew/bin/gh')).toEqual([
      '-c',
      'credential.helper=',
      '-c',
      'credential.helper=!"/opt/homebrew/bin/gh" auth git-credential',
    ]);
    expect(credentialArgs('/weird path/gh')).toEqual(['-c', 'credential.helper=']);
    expect(credentialArgs('/x/$(boom)/gh')).toEqual(['-c', 'credential.helper=']);
    expect(credentialArgs(null)).toEqual(['-c', 'credential.helper=']);
  });

  it('fetches exactly the two commits, shallow and blobless, then diffs them', async () => {
    const calls: ExecRequest[] = [];
    const exec: Exec = async (r) => {
      calls.push(r);
      return { stdout: r.args.includes('diff') ? 'DIFF' : '', stderr: '', code: 0 };
    };
    const tc: ToolchainService = {
      get: async () => ({ gh: '/gh', claude: null, git: '/git', path: '/usr/bin' }),
      reset: () => undefined,
    };
    const dir = await mkdtemp(join(tmpdir(), 'pr-lens-git-'));
    expect(
      await createGit(exec, tc, { repos: dir, worktrees: join(dir, 'wt') }).directDiff(
        { owner: 'o', repo: 'r' },
        A,
        B,
      ),
    ).toBe('DIFF');
    const fetch = calls.find((c) => c.args.includes('fetch'))!;
    expect(fetch.args).toEqual(
      expect.arrayContaining([
        '--depth=1',
        '--filter=blob:none',
        '--no-tags',
        'https://github.com/o/r.git',
        A,
        B,
      ]),
    );
    expect(fetch.env?.GIT_TERMINAL_PROMPT).toBe('0');
    expect(calls.at(-1)!.args.slice(-6)).toEqual([
      'diff',
      '--no-color',
      '--no-ext-diff',
      '-M',
      A,
      B,
    ]);
  });

  it('refuses non-SHA input and explains a missing git', async () => {
    const tc: ToolchainService = {
      get: async () => ({ gh: null, claude: null, git: null, path: '' }),
      reset: () => undefined,
    };
    const git = createGit(async () => ({ stdout: '', stderr: '', code: 0 }), tc, {
      repos: tmpdir(),
      worktrees: tmpdir(),
    });
    expect(() => git.directDiff({ owner: 'o', repo: 'r' }, 'main', B)).toThrow();
    await expect(git.directDiff({ owner: 'o', repo: 'r' }, A, B)).rejects.toMatchObject({
      code: 'BIN_NOT_FOUND',
    });
  });
});

describe('release summary', () => {
  const notes = [
    {
      id: 'ai-aaaa1111',
      source: 'ai' as const,
      fid: 'F1',
      path: 'a.ts',
      side: 'RIGHT' as const,
      startLineId: 'F1-001',
      endLineId: 'F1-001',
      startLine: 3,
      endLine: 3,
      fileLevel: false,
      severity: 'high' as const,
      category: 'security' as const,
      title: 'Leak',
      body: '',
      refs: [],
      confidence: 1,
      score: 3,
      repaired: false,
    },
  ];
  it('keeps only risky IDs that are real notes', () => {
    const out: ReleaseOutput = {
      headline: 'h',
      changes: [{ area: 'auth', bullets: ['b'] }],
      risky: ['ai-aaaa1111', 'ai-made-up', 'ai-aaaa1111'],
    };
    expect(validateRelease(out, notes).risky).toEqual(['ai-aaaa1111']);
  });
  it('sends commits, the file list and note IDs, but no diff lines', () => {
    const ctx = compareContext({
      owner: 'o',
      repo: 'r',
      base: 'v1',
      head: 'v2',
      mode: 'three-dot',
      baseSha: A,
      headSha: B,
      mergeBaseSha: A,
      aheadBy: 1,
      behindBy: 0,
      totalCommits: 1,
      commits: [{ sha: B, subject: 'feat: add memo (#12)', author: 'x' }],
      baseIsTag: true,
      headIsTag: true,
      url: '',
    });
    const prompt = buildReleasePrompt(ctx, { files: [] }, notes);
    expect(prompt).toContain('bbbbbbb feat: add memo (#12)');
    expect(prompt).toContain('ai-aaaa1111 [high · security] a.ts:3 Leak');
    expect(prompt).toContain('<compare repo="o/r" base="v1 @ aaaaaaa"');
  });
});

describe('review service: compare', () => {
  const settings = Settings.parse({});
  const settingsService: SettingsService = {
    current: () => settings,
    view: async () => ({ ...settings, hasOAuthToken: false }),
    update: () => Promise.reject(new Error('unused')),
    setOAuthToken: () => Promise.reject(new Error('unused')),
    oauthToken: async () => null,
  };
  const make = async (behindBy: number) => {
    const github: GitHubClient = {
      health: () => Promise.reject(new Error('unused')),
      prMeta: () => Promise.reject(new Error('unused')),
      prDiff: () => Promise.reject(new Error('unused')),
      prContext: () => Promise.reject(new Error('unused')),
      resolveCommit: async (_r, ref) => (ref === 'v1' ? A : B),
      compare: async () => ({
        mergeBaseSha: A,
        aheadBy: 2,
        behindBy,
        totalCommits: 2,
        commits: [],
        url: 'u',
      }),
      compareDiff: vi.fn(async () => SAMPLE_DIFF),
      tagsAmong: async () => new Set(['v1', 'v2']),
      searchRefs: () => Promise.reject(new Error('unused')),
      inbox: () => Promise.reject(new Error('unused')),
    };
    const git = {
      directDiff: vi.fn(async () => SAMPLE_DIFF),
      worktree: () => Promise.reject(new Error('unused')),
      treePaths: () => Promise.reject(new Error('unused')),
      sourceFiles: () => Promise.reject(new Error('unused')),
    };
    const release = vi.fn(async () => ({
      output: {
        headline: 'Big release',
        changes: [{ area: 'auth', bullets: ['memo'] }],
        risky: [],
      },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }));
    const claude: ClaudeClient = {
      health: () => Promise.reject(new Error('unused')),
      review: () => Promise.reject(new Error('unused')),
      merge: () => Promise.reject(new Error('unused')),
      release,
    };
    const events: ReviewEvent[] = [];
    const store = createJsonStore(await mkdtemp(join(tmpdir(), 'pr-lens-cmp-')));
    const svc = createReviewService({
      github,
      git,
      claude,
      settings: settingsService,
      sandboxDir: '/tmp',
      emit: (e) => events.push(e),
      cache: createAnalysisCache(store),
    });
    const next = () =>
      vi.waitFor(() => {
        const e = events.find((x) => x.type === 'release' || x.type === 'error');
        if (!e) throw new Error('not yet');
        events.length = 0;
        return e;
      });
    return { svc, github, git, release, next };
  };

  it('uses the GitHub three-dot diff, and git only for a two-dot range that diverged', async () => {
    const ancestor = await make(0);
    const range = { owner: 'o', repo: 'r', base: 'v1', head: 'v2' };
    const a2 = await ancestor.svc.openCompare({ ...range, mode: 'two-dot' });
    const a3 = await ancestor.svc.openCompare({ ...range, mode: 'three-dot' });
    expect(ancestor.git.directDiff).not.toHaveBeenCalled();
    // Same diff, same subject: one review and one set of notes serve both modes.
    expect(a2.target.key).toBe(a3.target.key);
    expect(a2.header).toMatchObject({ meta: { mode: 'two-dot' } });

    const diverged = await make(3);
    const three = await diverged.svc.openCompare({
      owner: 'o',
      repo: 'r',
      base: 'v1',
      head: 'v2',
      mode: 'three-dot',
    });
    expect(diverged.git.directDiff).not.toHaveBeenCalled();
    const two = await diverged.svc.openCompare({
      owner: 'o',
      repo: 'r',
      base: 'v1',
      head: 'v2',
      mode: 'two-dot',
    });
    expect(diverged.git.directDiff).toHaveBeenCalledWith({ owner: 'o', repo: 'r' }, A, B);
    expect(three.target.key).not.toBe(two.target.key);
    expect(two.header).toMatchObject({
      kind: 'compare',
      meta: { baseIsTag: true, headIsTag: true, behindBy: 3 },
    });
  });

  it('writes a release summary once, then serves it from the cache', async () => {
    const { svc, release, next } = await make(0);
    const opened = await svc.openCompare({
      owner: 'o',
      repo: 'r',
      base: 'v1',
      head: 'v2',
      mode: 'three-dot',
    });
    expect(opened.release).toBeNull();
    svc.start(opened.target.key, false, 'release');
    expect(await next()).toMatchObject({
      type: 'release',
      cached: false,
      release: { headline: 'Big release' },
    });
    svc.start(opened.target.key, false, 'release');
    expect(await next()).toMatchObject({ type: 'release', cached: true });
    expect(release).toHaveBeenCalledTimes(1);
    expect(
      (await svc.openCompare({ owner: 'o', repo: 'r', base: 'v1', head: 'v2', mode: 'three-dot' }))
        .release?.headline,
    ).toBe('Big release');
  });
});
