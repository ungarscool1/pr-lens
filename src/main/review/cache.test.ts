import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PrMeta } from '../../shared/pr';
import type { Analysis, ModelOutput, ReviewEvent } from '../../shared/review';
import { DEFAULT_NOISE_GLOBS, Settings } from '../../shared/settings';
import { SAMPLE_DIFF } from '../diff/fixtures';
import type { GitHubClient } from '../github/gh';
import type { SettingsService } from '../settings/settings';
import { createJsonStore } from '../store/json-store';
import { createAnalysisCache, settingsKey } from './cache';
import type { ClaudeClient } from './claude';
import { createReviewService } from './service';

const ref = { owner: 'acme', repo: 'api', number: 812 };
const HEAD = '9bd04e1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const settings = Settings.parse({});

const analysis = (over: Partial<Analysis> = {}): Analysis => ({
  targetKey: `acme/api#812@${HEAD}`,
  headSha: HEAD,
  promptVersion: 'review.v1',
  summary: 's',
  files: [],
  readingOrder: [],
  notes: [],
  dropped: [],
  chunks: 1,
  failedChunks: 0,
  merge: 'none',
  redactions: [],
  createdAt: 1,
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ...over,
});

const tempStore = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pr-lens-cache-'));
  return { dir, store: createJsonStore(dir) };
};

describe('settingsKey', () => {
  it('changes with model, note cap or globs, not with glob order', () => {
    const k = settingsKey(settings);
    expect(settingsKey({ ...settings, noiseGlobs: [...DEFAULT_NOISE_GLOBS].reverse() })).toBe(k);
    expect(settingsKey({ ...settings, model: 'opus' })).not.toBe(k);
    expect(settingsKey({ ...settings, maxNotes: 5 })).not.toBe(k);
    expect(settingsKey({ ...settings, noiseGlobs: ['**/*.lock'] })).not.toBe(k);
  });
});

describe('createAnalysisCache', () => {
  it('round-trips per (repo, PR, head SHA)', async () => {
    const { dir, store } = await tempStore();
    const cache = createAnalysisCache(store);
    await cache.put(ref, analysis(), settings);
    expect(await cache.get(ref, HEAD, settings)).toEqual({ analysis: analysis(), stale: false });
    expect(await cache.get(ref, 'b'.repeat(40), settings)).toBeNull();
    expect(await cache.get({ ...ref, number: 813 }, HEAD, settings)).toBeNull();
    const raw = JSON.parse(
      await readFile(join(dir, `analyses/acme__api__812/${HEAD}.json`), 'utf8'),
    );
    expect(raw).toMatchObject({ version: 1, settingsKey: settingsKey(settings) });
  });

  it('flags a hit made with other settings as stale instead of dropping it', async () => {
    const { store } = await tempStore();
    const cache = createAnalysisCache(store);
    await cache.put(ref, analysis(), settings);
    expect(await cache.get(ref, HEAD, { ...settings, maxNotes: 3 })).toMatchObject({ stale: true });
  });

  it('treats corrupt or old-version files as a miss, without logging their content', async () => {
    const { dir, store } = await tempStore();
    const cache = createAnalysisCache(store);
    await cache.put(ref, analysis(), settings);
    const path = join(dir, `analyses/acme__api__812/${HEAD}.json`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await writeFile(path, '{"secret diff text": ');
    expect(await cache.get(ref, HEAD, settings)).toBeNull();
    await writeFile(path, JSON.stringify({ version: 0, settingsKey: 'x', analysis: {} }));
    expect(await cache.get(ref, HEAD, settings)).toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret diff text');
    warn.mockRestore();
  });

  it('refuses a head SHA that is not a SHA', async () => {
    const { store } = await tempStore();
    await expect(createAnalysisCache(store).get(ref, '../../etc', settings)).rejects.toThrow();
  });
});

describe('review service with the cache', () => {
  const meta: PrMeta = {
    url: '',
    title: 'T',
    body: '',
    state: 'OPEN',
    isDraft: false,
    author: 'a',
    baseRefName: 'main',
    headRefName: 'f',
    baseSha: '3f2a91c0',
    headSha: HEAD,
    commitCount: 1,
    linkedIssues: [],
  };
  const github: GitHubClient = {
    health: () => Promise.reject(new Error('unused')),
    prMeta: async () => meta,
    prDiff: async () => SAMPLE_DIFF,
  };
  const output: ModelOutput = { summary: 'reviewed', files: [], reading_order: [], notes: [] };
  const makeClaude = () => {
    const review = vi.fn(async () => ({ output, usage: analysis().usage }));
    const client: ClaudeClient = {
      health: () => Promise.reject(new Error('unused')),
      review,
      merge: () => Promise.reject(new Error('unused')),
    };
    return { client, review };
  };
  const settingsService = (s: Settings): SettingsService => ({
    current: () => s,
    view: async () => ({ ...s, hasOAuthToken: false }),
    update: () => Promise.reject(new Error('unused')),
    setOAuthToken: () => Promise.reject(new Error('unused')),
    oauthToken: async () => null,
  });
  const service = (
    store: ReturnType<typeof createJsonStore>,
    claude: ClaudeClient,
    s = settings,
  ) => {
    const events: ReviewEvent[] = [];
    const svc = createReviewService({
      github,
      claude,
      settings: settingsService(s),
      sandboxDir: '/tmp',
      emit: (e) => events.push(e),
      cache: createAnalysisCache(store),
    });
    const done = () =>
      vi.waitFor(() => {
        const e = events.find((x) => x.type === 'done' || x.type === 'error');
        if (!e) throw new Error('not yet');
        events.length = 0;
        return e;
      });
    return { svc, done };
  };

  it('serves a review from disk after a restart, and re-runs only on force', async () => {
    const { store } = await tempStore();
    const first = makeClaude();
    const a = service(store, first.client);
    const opened = await a.svc.openPr('acme/api#812');
    expect(opened.analysis).toBeNull();
    a.svc.start(opened.target.key, false);
    expect(await a.done()).toMatchObject({ type: 'done', cache: { from: 'run', saved: true } });

    // A new service instance is what an app restart looks like.
    const second = makeClaude();
    const b = service(store, second.client);
    const reopened = await b.svc.openPr('acme/api#812');
    expect(reopened.analysis?.summary).toBe('reviewed');
    expect(reopened.cache).toEqual({ from: 'cache', stale: false, saved: true });
    b.svc.start(reopened.target.key, false);
    expect(await b.done()).toMatchObject({ type: 'done', cache: { from: 'cache' } });
    expect(second.review).not.toHaveBeenCalled();

    b.svc.start(reopened.target.key, true);
    expect(await b.done()).toMatchObject({ type: 'done', cache: { from: 'run' } });
    expect(second.review).toHaveBeenCalledTimes(1);
  });

  it('marks a cached review stale after a settings change', async () => {
    const { store } = await tempStore();
    const a = service(store, makeClaude().client);
    const opened = await a.svc.openPr('acme/api#812');
    a.svc.start(opened.target.key, false);
    await a.done();
    const b = service(store, makeClaude().client, { ...settings, maxNotes: 4 });
    expect((await b.svc.openPr('acme/api#812')).cache?.stale).toBe(true);
  });
});
