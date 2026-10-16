import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Settings } from '../../shared/settings';
import { execFileRunner } from '../exec/exec';
import { createToolchain } from '../exec/toolchain';
import { createGit } from '../git/git';
import { createGhClient } from '../github/gh';
import type { SettingsService } from '../settings/settings';
import { createJsonStore } from '../store/json-store';
import { createAnalysisCache } from './cache';
import type { ClaudeClient } from './claude';
import { createReviewService } from './service';

/**
 * Live check of the compare path against real gh + git (no claude, no tokens):
 *   PR_LENS_LIVE=1 pnpm test compare.live
 */
describe.skipIf(!process.env.PR_LENS_LIVE)('live compare', () => {
  const make = async () => {
    const toolchain = createToolchain(execFileRunner, () => ({ ghPath: null, claudePath: null }));
    const dir = await mkdtemp(join(tmpdir(), 'pr-lens-live-cmp-'));
    const settings = Settings.parse({});
    const settingsService: SettingsService = {
      current: () => settings,
      view: async () => ({ ...settings, hasOAuthToken: false }),
      update: () => Promise.reject(new Error('unused')),
      setOAuthToken: () => Promise.reject(new Error('unused')),
      oauthToken: async () => null,
    };
    const unused = (): Promise<never> => Promise.reject(new Error('claude is not used here'));
    const claude: ClaudeClient = { health: unused, review: unused, merge: unused, release: unused };
    return createReviewService({
      github: createGhClient(execFileRunner, toolchain),
      git: createGit(execFileRunner, toolchain, {
        repos: join(dir, 'git'),
        worktrees: join(dir, 'wt'),
      }),
      claude,
      settings: settingsService,
      sandboxDir: dir,
      emit: () => undefined,
      cache: createAnalysisCache(createJsonStore(dir)),
    });
  };

  it('compares two tags, three-dot, and flags them as tags', async () => {
    const svc = await make();
    const r = await svc.openCompare({
      owner: 'cli',
      repo: 'cli',
      base: 'v2.60.0',
      head: 'v2.61.0',
      mode: 'three-dot',
    });
    expect(r.header).toMatchObject({
      kind: 'compare',
      meta: { aheadBy: 96, behindBy: 0, baseIsTag: true, headIsTag: true },
    });
    expect(r.diff.files.length).toBe(38);
  }, 120_000);

  it('diffs a diverged range directly through git when three-dot is empty', async () => {
    const svc = await make();
    const range = {
      owner: 'cli',
      repo: 'cli',
      base: 'b758ce35643e64cfe4d61bc58b6009c4088e5e0c',
      head: '3d7967df5a94052b0554898ffa02526f0f90b8c9',
    };
    const three = await svc.openCompare({ ...range, mode: 'three-dot' });
    const two = await svc.openCompare({ ...range, mode: 'two-dot' });
    expect(three.diff.files).toHaveLength(0);
    expect(two.header).toMatchObject({ meta: { behindBy: 3, mode: 'two-dot' } });
    expect(two.diff.files.length).toBeGreaterThan(0);
    expect(
      two.diff.files.every((f) => f.hunks.length > 0 || f.binary || f.status === 'renamed'),
    ).toBe(true);
  }, 300_000);

  it('explains an unknown ref', async () => {
    const svc = await make();
    await expect(
      svc.openCompare({
        owner: 'cli',
        repo: 'cli',
        base: 'v2.60.0',
        head: 'no-such-ref-xyz',
        mode: 'three-dot',
      }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('no-such-ref-xyz'),
    });
  }, 60_000);
});
