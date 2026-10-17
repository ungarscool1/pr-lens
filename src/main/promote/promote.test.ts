import { describe, expect, it, vi } from 'vitest';
import type { Analysis } from '../../shared/review';
import { Settings } from '../../shared/settings';
import type { Subject } from '../../shared/subject';
import { buildDiffModel } from '../diff/parse';
import { SAMPLE_DIFF } from '../diff/fixtures';
import type { Exec, ExecRequest } from '../exec/exec';
import type { ToolchainService } from '../exec/toolchain';
import type { NotesService } from '../notes/notes';
import type { ResolvedNote } from '../notes/resolve';
import type { AnalysisCache } from '../review/cache';
import type { LoadedTarget } from '../review/service';
import type { SettingsService } from '../settings/settings';
import { CONFIRM_TTL_MS, createPromote, defaultBody, threadFor } from './promote';
import { classifyWriteError, createWriteClient } from './write-client';
import type { GitHubWriteClient } from './write-client';

const HEAD = 'c'.repeat(40);
const subject: Subject = { kind: 'pr', ref: { owner: 'acme', repo: 'api', number: 812 } };
const key = `acme/api#812@${HEAD}`;

const aiNote = (over: Partial<Analysis['notes'][number]> = {}): Analysis['notes'][number] => ({
  id: 'ai-abcd1234',
  source: 'ai',
  fid: 'F5',
  path: 'src/auth/session.ts',
  side: 'RIGHT',
  startLineId: 'F5-005',
  endLineId: 'F5-007',
  startLine: 40,
  endLine: 42,
  fileLevel: false,
  severity: 'high',
  category: 'security',
  title: 'Memo can serve revoked sessions',
  body: 'Never evicted.',
  question: 'How is it invalidated?',
  refs: [],
  confidence: 0.8,
  score: 2.9,
  repaired: false,
  ...over,
});

describe('comment shape', () => {
  const n: ResolvedNote = {
    id: 'ai-abcd1234',
    source: 'ai',
    label: '[high · security]',
    title: 'T',
    body: 'B',
    question: 'Q?',
    path: 'a.ts',
    side: 'RIGHT',
    startLine: 40,
    endLine: 42,
    fileLevel: false,
  };
  it('builds the default body from title, explanation and question', () => {
    expect(defaultBody(n)).toBe('**T**\n\nB\n\nQ?');
    expect(defaultBody({ ...n, source: 'me', body: 'mine' })).toBe('mine');
  });
  it('anchors multi-line, single-line and file-level threads', () => {
    expect(threadFor(n, 'x')).toEqual({
      kind: 'line',
      path: 'a.ts',
      side: 'RIGHT',
      line: 42,
      startLine: 40,
      body: 'x',
    });
    expect(threadFor({ ...n, startLine: 42 }, 'x')).toEqual({
      kind: 'line',
      path: 'a.ts',
      side: 'RIGHT',
      line: 42,
      body: 'x',
    });
    expect(threadFor({ ...n, fileLevel: true }, 'x')).toEqual({
      kind: 'file',
      path: 'a.ts',
      body: 'x',
    });
  });
});

describe('write client', () => {
  const tc: ToolchainService = {
    get: async () => ({ gh: '/gh', claude: null, git: null, path: '' }),
    reset: () => undefined,
  };
  const capture = (stdout: unknown) => {
    const calls: ExecRequest[] = [];
    const exec: Exec = async (r) => {
      calls.push(r);
      return { stdout: JSON.stringify(stdout), stderr: '', code: 0 };
    };
    return { calls, client: createWriteClient(exec, tc) };
  };
  const arg = (c: ExecRequest, flag: string, name: string) =>
    c.args[c.args.findIndex((a, i) => c.args[i - 1] === flag && a.startsWith(`${name}=`))];

  it('creates a review without an event, so it stays pending', async () => {
    const { calls, client } = capture({
      data: { addPullRequestReview: { pullRequestReview: { id: 'R1', state: 'PENDING' } } },
    });
    expect(await client.createPendingReview('PR1', HEAD)).toBe('R1');
    const q = arg(calls[0]!, '-f', 'query') ?? '';
    expect(q).toContain('addPullRequestReview');
    expect(q).not.toMatch(/event/i);
  });

  it('refuses a review that came back as anything but pending', async () => {
    const { client } = capture({
      data: { addPullRequestReview: { pullRequestReview: { id: 'R1', state: 'COMMENTED' } } },
    });
    await expect(client.createPendingReview('PR1', HEAD)).rejects.toThrow(/instead of a pending/);
  });

  it('sends the body as a raw string and lines as numbers', async () => {
    const { calls, client } = capture({
      data: {
        addPullRequestReviewThread: {
          thread: { comments: { nodes: [{ url: 'https://github.com/x#r1' }] } },
        },
      },
    });
    const r = await client.addThread('R1', {
      kind: 'line',
      path: 'a.ts',
      side: 'RIGHT',
      line: 42,
      startLine: 40,
      body: '@/etc/passwd',
    });
    expect(r.url).toBe('https://github.com/x#r1');
    expect(arg(calls[0]!, '-f', 'body')).toBe('body=@/etc/passwd'); // -f: never read as a file
    expect(arg(calls[0]!, '-F', 'line')).toBe('line=42');
    expect(arg(calls[0]!, '-F', 'startLine')).toBe('startLine=40');
    expect(arg(calls[0]!, '-f', 'startSide')).toBe('startSide=RIGHT');
  });

  it('submits a pending review with the chosen GitHub event', async () => {
    const { calls, client } = capture({
      data: {
        submitPullRequestReview: {
          pullRequestReview: { state: 'CHANGES_REQUESTED', url: 'https://github.com/x#review' },
        },
      },
    });
    await expect(client.submitReview('R1', 'REQUEST_CHANGES', 'Needs a test.')).resolves.toEqual({
      state: 'CHANGES_REQUESTED',
      url: 'https://github.com/x#review',
    });
    expect(arg(calls[0]!, '-f', 'query')).toContain('submitPullRequestReview');
    expect(arg(calls[0]!, '-f', 'event')).toBe('event=REQUEST_CHANGES');
    expect(arg(calls[0]!, '-f', 'body')).toBe('body=Needs a test.');
  });

  it('finds only the viewer’s own pending review', async () => {
    const { client } = capture({
      data: {
        viewer: { login: 'me' },
        repository: {
          pullRequest: {
            id: 'PR1',
            headRefOid: HEAD,
            reviews: {
              nodes: [
                { id: 'X', author: { login: 'other' } },
                { id: 'R9', author: { login: 'me' } },
              ],
            },
          },
        },
      },
    });
    expect(await client.reviewContext(subject.ref)).toEqual({
      prId: 'PR1',
      headSha: HEAD,
      viewer: 'me',
      pendingReviewId: 'R9',
    });
  });

  it.each([
    ['Your token has not been granted the required scopes', 'GH_NOT_AUTHENTICATED'],
    ['Resource not accessible by integration', 'GH_NOT_AUTHENTICATED'],
    ['pull_request_review_thread.line could not be resolved', 'BAD_INPUT'],
  ])('%s → %s', (stderr, code) => expect(classifyWriteError(stderr).code).toBe(code));
});

describe('promote service', () => {
  const make = (
    opts: { enabled?: boolean; pending?: string | null; head?: string; subject?: Subject } = {},
  ) => {
    let t = 1_000;
    const settings = Settings.parse({ promoteEnabled: opts.enabled ?? true });
    const write: GitHubWriteClient = {
      reviewContext: vi.fn(async () => ({
        prId: 'PR1',
        headSha: opts.head ?? HEAD,
        viewer: 'me',
        pendingReviewId: opts.pending ?? null,
      })),
      createPendingReview: vi.fn(async () => 'R-new'),
      addThread: vi.fn(async () => ({ url: 'https://github.com/acme/api/pull/812#discussion_r1' })),
      submitReview: vi.fn(async () => ({ url: 'https://github.com/acme/api/pull/812#pullrequestreview-1', state: 'APPROVED' })),
    };
    const patchState = vi.fn(async () => undefined);
    const loaded: LoadedTarget = {
      target: { key, subject: opts.subject ?? subject, headSha: HEAD },
      header: { kind: 'pr', meta: {} as never },
      diff: buildDiffModel(SAMPLE_DIFF, []),
      context: { tag: 'pr', attrs: {}, title: '', description: '', sections: [] },
    };
    const svc = createPromote({
      write,
      review: { loaded: (k) => (k === key ? loaded : undefined) },
      cache: {
        get: async () => ({ analysis: { notes: [aiNote()] } as Analysis, stale: false }),
      } as unknown as AnalysisCache,
      notes: { list: async () => ({ mine: [], state: {} }), patchState } as unknown as NotesService,
      settings: { current: () => settings } as unknown as SettingsService,
      now: () => t,
    });
    return { svc, write, patchState, advance: (ms: number) => (t += ms) };
  };

  it('does nothing while the setting is off', async () => {
    const { svc, write } = make({ enabled: false });
    await expect(svc.preview(key, 'ai-abcd1234')).rejects.toThrow(/Settings/);
    expect(write.reviewContext).not.toHaveBeenCalled();
  });

  it('previews without writing, then posts into a new pending review on confirm', async () => {
    const { svc, write, patchState } = make();
    const p = await svc.preview(key, 'ai-abcd1234');
    expect(p).toMatchObject({
      pr: 'acme/api#812',
      viewer: 'me',
      pendingReviewExists: false,
      startLine: 40,
      endLine: 42,
    });
    expect(p.body).toContain('**Memo can serve revoked sessions**');
    expect(write.createPendingReview).not.toHaveBeenCalled();
    expect(write.addThread).not.toHaveBeenCalled();

    const r = await svc.confirm(p.confirmToken, '  edited body  ');
    expect(write.createPendingReview).toHaveBeenCalledWith('PR1', HEAD);
    expect(write.addThread).toHaveBeenCalledWith('R-new', {
      kind: 'line',
      path: 'src/auth/session.ts',
      side: 'RIGHT',
      line: 42,
      startLine: 40,
      body: 'edited body',
    });
    expect(patchState).toHaveBeenCalledWith(subject, 'ai-abcd1234', { promoted: true });
    expect(r.url).toContain('#discussion_r1');
  });

  it('joins an existing pending review instead of starting one', async () => {
    const { svc, write } = make({ pending: 'R-existing' });
    const p = await svc.preview(key, 'ai-abcd1234');
    expect(p.pendingReviewExists).toBe(true);
    await svc.confirm(p.confirmToken, 'x');
    expect(write.createPendingReview).not.toHaveBeenCalled();
    expect(write.addThread).toHaveBeenCalledWith('R-existing', expect.anything());
  });

  it('submits the existing pending review and never writes private notes', async () => {
    const { svc, write, patchState } = make({ pending: 'R-existing' });
    await expect(svc.submitReview(key, 'REQUEST_CHANGES', 'Please fix this.')).resolves.toEqual({
      url: 'https://github.com/acme/api/pull/812#pullrequestreview-1',
      state: 'APPROVED',
    });
    expect(write.createPendingReview).not.toHaveBeenCalled();
    expect(write.submitReview).toHaveBeenCalledWith('R-existing', 'REQUEST_CHANGES', 'Please fix this.');
    expect(patchState).not.toHaveBeenCalled();
  });

  it('accepts each confirmation once, and not after it expires', async () => {
    const { svc, write, advance } = make();
    const p = await svc.preview(key, 'ai-abcd1234');
    await svc.confirm(p.confirmToken, 'x');
    await expect(svc.confirm(p.confirmToken, 'x')).rejects.toThrow(/expired/);
    const late = await svc.preview(key, 'ai-abcd1234');
    advance(CONFIRM_TTL_MS + 1);
    await expect(svc.confirm(late.confirmToken, 'x')).rejects.toThrow(/expired/);
    expect(write.addThread).toHaveBeenCalledTimes(1);
  });

  it('refuses when the PR head moved, and for compare ranges', async () => {
    await expect(make({ head: 'd'.repeat(40) }).svc.preview(key, 'ai-abcd1234')).rejects.toThrow(
      /new commits/,
    );
    const compare: Subject = {
      kind: 'compare',
      owner: 'acme',
      repo: 'api',
      baseSha: 'a'.repeat(40),
      headSha: HEAD,
      mode: 'three-dot',
    };
    await expect(make({ subject: compare }).svc.preview(key, 'ai-abcd1234')).rejects.toThrow(
      /pull request/,
    );
  });
});
