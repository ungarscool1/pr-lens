import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../shared/errors';
import type { Analysis } from '../../shared/review';
import { Settings } from '../../shared/settings';
import type { Subject } from '../../shared/subject';
import { buildDiffModel } from '../diff/parse';
import { SAMPLE_DIFF } from '../diff/fixtures';
import type { Exec, ExecRequest } from '../exec/exec';
import type { ToolchainService } from '../exec/toolchain';
import { createNotes } from '../notes/notes';
import type { ResolvedNote } from '../notes/resolve';
import type { AnalysisCache } from '../review/cache';
import type { LoadedTarget } from '../review/service';
import type { SettingsService } from '../settings/settings';
import type { JsonStore } from '../store/json-store';
import { CONFIRM_TTL_MS, createPromote, defaultBody, threadFor } from './promote';
import { classifyWriteError, createWriteClient } from './write-client';
import type { CommentInfo, GitHubWriteClient } from './write-client';

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
    expect(r).toEqual({ url: 'https://github.com/x#r1', commentId: null });
    expect(arg(calls[0]!, '-f', 'body')).toBe('body=@/etc/passwd'); // -f: never read as a file
    expect(arg(calls[0]!, '-F', 'line')).toBe('line=42');
    expect(arg(calls[0]!, '-F', 'startLine')).toBe('startLine=40');
    expect(arg(calls[0]!, '-f', 'startSide')).toBe('startSide=RIGHT');
  });

  it('reads the new comment’s ID from the thread', async () => {
    const { calls, client } = capture({
      data: {
        addPullRequestReviewThread: {
          thread: { comments: { nodes: [{ id: 'PRRC_kw1', url: 'https://github.com/x#r1' }] } },
        },
      },
    });
    const r = await client.addThread('R1', { kind: 'file', path: 'a.ts', body: 'x' });
    expect(r).toEqual({ url: 'https://github.com/x#r1', commentId: 'PRRC_kw1' });
    expect(arg(calls[0]!, '-f', 'query')).toMatch(/nodes \{ id url \}/);
  });

  it('asks GitHub about a comment by ID, with the ID as a raw string', async () => {
    const { calls, client } = capture({
      data: {
        viewer: { login: 'me' },
        node: {
          state: 'PENDING',
          author: { login: 'me' },
          viewerCanUpdate: true,
          pullRequest: { number: 812, repository: { owner: { login: 'acme' }, name: 'api' } },
        },
      },
    });
    expect(await client.pendingComment('PRRC_kw1')).toEqual({
      state: 'PENDING',
      author: 'me',
      viewer: 'me',
      viewerCanUpdate: true,
      owner: 'acme',
      repo: 'api',
      number: 812,
    });
    const c = calls[0]!;
    expect(c.args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(arg(c, '-f', 'query')).toContain('... on PullRequestReviewComment');
    expect(arg(c, '-f', 'comment')).toBe('comment=PRRC_kw1');
    expect(c.args.filter((a) => a === '-F')).toHaveLength(0);
  });

  it('treats a node that is not a review comment as missing', async () => {
    expect(
      await capture({ data: { viewer: { login: 'me' }, node: {} } }).client.pendingComment('X'),
    ).toBeNull();
    expect(
      await capture({ data: { viewer: { login: 'me' }, node: null } }).client.pendingComment('X'),
    ).toBeNull();
  });

  it('updates a comment body with -f, so a leading @ is never read as a file', async () => {
    const { calls, client } = capture({
      data: { updatePullRequestReviewComment: { pullRequestReviewComment: { id: 'PRRC_kw1' } } },
    });
    await client.updateComment('PRRC_kw1', '@/etc/passwd');
    const c = calls[0]!;
    expect(arg(c, '-f', 'query')).toContain('updatePullRequestReviewComment');
    expect(arg(c, '-f', 'comment')).toBe('comment=PRRC_kw1');
    expect(arg(c, '-f', 'body')).toBe('body=@/etc/passwd');
    expect(arg(c, '-F', 'body')).toBeUndefined();
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
    ["GraphQL: Could not resolve to a node with the global id of 'PRRC_x'", 'NOT_FOUND'],
  ])('%s → %s', (stderr, code) => expect(classifyWriteError(stderr).code).toBe(code));
});

/** A JsonStore in memory, parsing on read like the real one. */
const memoryStore = (): JsonStore => {
  const files = new Map<string, string>();
  return {
    async read(name, schema, fallback) {
      const raw = files.get(name);
      if (raw === undefined) return fallback;
      const parsed = schema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error(`Stored file ${name} does not match its schema`);
      return parsed.data;
    },
    async write(name, value) {
      files.set(name, JSON.stringify(value));
    },
  };
};

const pending = (over: Partial<CommentInfo> = {}): CommentInfo => ({
  state: 'PENDING',
  author: 'me',
  viewer: 'me',
  viewerCanUpdate: true,
  owner: 'acme',
  repo: 'api',
  number: 812,
  ...over,
});

describe('promote service', () => {
  const make = (
    opts: {
      enabled?: boolean;
      pending?: string | null;
      head?: string;
      subject?: Subject;
      /** What `pendingComment` reports, or the error it throws. */
      comment?: CommentInfo | null | Error;
      updateError?: Error;
    } = {},
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
      addThread: vi.fn(async () => ({
        url: 'https://github.com/acme/api/pull/812#discussion_r1',
        commentId: 'PRRC_1',
      })),
      submitReview: vi.fn(async () => ({ url: 'https://github.com/acme/api/pull/812#pullrequestreview-1', state: 'APPROVED' })),
      pendingComment: vi.fn(async () => {
        const c = opts.comment === undefined ? pending() : opts.comment;
        if (c instanceof Error) throw c;
        return c;
      }),
      updateComment: vi.fn(async () => {
        if (opts.updateError) throw opts.updateError;
      }),
    };
    const s = opts.subject ?? subject;
    const notes = createNotes(memoryStore());
    const patchState = vi.spyOn(notes, 'patchState');
    const loaded: LoadedTarget = {
      target: { key, subject: s, headSha: HEAD },
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
      notes,
      settings: { current: () => settings } as unknown as SettingsService,
      now: () => t,
    });
    /** A private note on the subject. */
    const addMine = (body = 'my note') =>
      notes.create(s, { path: 'src/auth/session.ts', side: 'RIGHT', line: 41, lineId: 'F5-006', body });
    /** Links a note as `confirm` would have. */
    const link = async (id: string, body: string) => {
      await notes.patchState(s, id, { promoted: true });
      await notes.setPublished(s, id, { commentId: 'PRRC_1', body });
      patchState.mockClear();
    };
    return {
      svc,
      write,
      notes,
      patchState,
      addMine,
      link,
      file: () => notes.list(s),
      advance: (ms: number) => (t += ms),
    };
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
    expect(r).toEqual({ url: 'https://github.com/acme/api/pull/812#discussion_r1' });
  });

  it('links the note to its new comment with the posted text', async () => {
    const { svc, file } = make();
    const p = await svc.preview(key, 'ai-abcd1234');
    await svc.confirm(p.confirmToken, '  posted  ');
    const f = await file();
    expect(f.published).toEqual({ 'ai-abcd1234': { commentId: 'PRRC_1', body: 'posted' } });
    expect(f.edits).toEqual({}); // the AI note itself is unchanged
  });

  it('copies the posted text into a private note, dialog changes included', async () => {
    const { svc, file, addMine } = make();
    const mine = await addMine('draft');
    const p = await svc.preview(key, mine.id);
    expect(p.body).toBe('draft');
    await svc.confirm(p.confirmToken, 'reworded for the author');
    const f = await file();
    expect(f.mine[0]?.body).toBe('reworded for the author');
    expect(f.published[mine.id]).toEqual({ commentId: 'PRRC_1', body: 'reworded for the author' });
    expect(f.state[mine.id]).toEqual({ promoted: true });
  });

  it('starts the comment from the edited AI body', async () => {
    const { svc, notes } = make();
    await notes.setEdit(subject, 'ai-abcd1234', 'My wording.');
    const p = await svc.preview(key, 'ai-abcd1234');
    expect(p.body).toBe('**Memo can serve revoked sessions**\n\nMy wording.\n\nHow is it invalidated?');
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

  it('drops every link once the review is submitted', async () => {
    const { svc, link, file, addMine } = make({ pending: 'R-existing' });
    const mine = await addMine();
    await link('ai-abcd1234', 'x');
    await link(mine.id, 'my note');
    await svc.submitReview(key, 'APPROVE', '');
    const f = await file();
    expect(f.published).toEqual({});
    expect(f.mine).toHaveLength(1);
  });

  it('keeps the links when submitting fails', async () => {
    const { svc, write, link, file } = make({ pending: 'R-existing' });
    await link('ai-abcd1234', 'x');
    vi.mocked(write.submitReview).mockRejectedValueOnce(new AppError('EXEC_FAILED'));
    await expect(svc.submitReview(key, 'APPROVE', '')).rejects.toThrow();
    expect(Object.keys((await file()).published)).toEqual(['ai-abcd1234']);
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

  describe('editNote', () => {
    const compare: Subject = {
      kind: 'compare',
      owner: 'acme',
      repo: 'api',
      baseSha: 'a'.repeat(40),
      headSha: HEAD,
      mode: 'three-dot',
    };
    const noGitHub = (write: GitHubWriteClient) => {
      expect(write.reviewContext).not.toHaveBeenCalled();
      expect(write.pendingComment).not.toHaveBeenCalled();
      expect(write.updateComment).not.toHaveBeenCalled();
    };

    it('saves an unlinked AI note locally, without gh, even on a compare with the setting off', async () => {
      const { svc, write, file } = make({ subject: compare, enabled: false });
      const r = await svc.editNote(key, 'ai-abcd1234', '  Clearer.  ');
      expect(r.synced).toBe('local');
      expect(r.reason).toBeUndefined();
      expect(r.notes.edits).toEqual({ 'ai-abcd1234': { body: 'Clearer.' } });
      expect((await file()).edits).toEqual(r.notes.edits);
      noGitHub(write);
    });

    it('saves an unlinked private note locally, within the private note limit', async () => {
      const { svc, write, file, addMine } = make();
      const mine = await addMine();
      const r = await svc.editNote(key, mine.id, 'changed my mind');
      expect(r).toMatchObject({ synced: 'local' });
      expect((await file()).mine[0]?.body).toBe('changed my mind');
      await expect(svc.editNote(key, mine.id, 'x'.repeat(10_001))).rejects.toThrow(/10,000/);
      expect((await file()).mine[0]?.body).toBe('changed my mind');
      noGitHub(write);
    });

    it('refuses empty or oversized bodies and unknown notes', async () => {
      const { svc, file } = make();
      await expect(svc.editNote(key, 'ai-abcd1234', '   ')).rejects.toThrow(/1 to 65,000/);
      await expect(svc.editNote(key, 'ai-abcd1234', 'x'.repeat(65_001))).rejects.toThrow(
        /1 to 65,000/,
      );
      await expect(svc.editNote(key, 'ai-zzzz9999', 'x')).rejects.toThrow(/no longer/);
      await expect(svc.editNote(key, 'me-zzzz9999', 'x')).rejects.toThrow(/deleted/);
      expect((await file()).edits).toEqual({});
    });

    it('refuses a linked note while the setting is off, and writes nothing', async () => {
      const { svc, write, link, file } = make({ enabled: false });
      await link('ai-abcd1234', 'posted');
      const before = await file();
      await expect(svc.editNote(key, 'ai-abcd1234', 'new')).rejects.toThrow(/Settings/);
      expect(await file()).toEqual(before);
      noGitHub(write);
    });

    it('updates the viewer’s pending comment with the exact body, then the link', async () => {
      const { svc, write, link, file } = make();
      await link('ai-abcd1234', 'posted');
      const r = await svc.editNote(key, 'ai-abcd1234', '@/etc/passwd is not a file here');
      expect(write.pendingComment).toHaveBeenCalledWith('PRRC_1');
      expect(write.updateComment).toHaveBeenCalledWith('PRRC_1', '@/etc/passwd is not a file here');
      expect(r.synced).toBe('github');
      expect(r.notes.published['ai-abcd1234']).toEqual({
        commentId: 'PRRC_1',
        body: '@/etc/passwd is not a file here',
      });
      expect(r.notes.state['ai-abcd1234']).toEqual({ promoted: true });
      expect(await file()).toEqual(r.notes);
    });

    it('updates a linked private note and its comment together', async () => {
      const { svc, write, link, file, addMine } = make();
      const mine = await addMine('posted');
      await link(mine.id, 'posted');
      const r = await svc.editNote(key, mine.id, 'x'.repeat(20_000));
      expect(r.synced).toBe('github');
      expect(write.updateComment).toHaveBeenCalledWith('PRRC_1', 'x'.repeat(20_000));
      const f = await file();
      expect(f.mine[0]?.body).toBe('x'.repeat(20_000));
      expect(f.published[mine.id]?.body).toBe('x'.repeat(20_000));
    });

    it('accepts the owner and repo in another letter case', async () => {
      const { svc, link } = make({ comment: pending({ owner: 'ACME', repo: 'Api' }) });
      await link('ai-abcd1234', 'posted');
      expect((await svc.editNote(key, 'ai-abcd1234', 'new')).synced).toBe('github');
    });

    type Opts = NonNullable<Parameters<typeof make>[0]>;
    it.each<[string, Opts, RegExp]>([
      ['submitted', { comment: pending({ state: 'SUBMITTED' }) }, /already submitted/],
      ['by someone else', { comment: pending({ author: 'other' }) }, /not one you can edit/],
      ['not editable', { comment: pending({ viewerCanUpdate: false }) }, /not one you can edit/],
      ['on another PR', { comment: pending({ number: 813 }) }, /another pull request/],
      ['in another repo', { comment: pending({ repo: 'web' }) }, /another pull request/],
      ['not a review comment', { comment: null }, /no longer on GitHub/],
      ['gone', { comment: new AppError('NOT_FOUND') }, /no longer on GitHub/],
      ['gone during the update', { updateError: new AppError('NOT_FOUND') }, /no longer on GitHub/],
    ])('a comment %s is unlinked and the edit saved locally', async (_, opts, reason) => {
      const { svc, write, link, file, addMine } = make(opts);
      const mine = await addMine('posted');
      await link('ai-abcd1234', 'posted');
      await link(mine.id, 'posted');

      const ai = await svc.editNote(key, 'ai-abcd1234', 'ai edit');
      expect(ai.synced).toBe('local');
      expect(ai.reason).toMatch(reason);
      const me = await svc.editNote(key, mine.id, 'my edit');
      expect(me).toMatchObject({ synced: 'local' });

      const f = await file();
      expect(f.published).toEqual({});
      expect(f.state['ai-abcd1234']).toEqual({ promoted: false });
      expect(f.state[mine.id]).toEqual({ promoted: false });
      expect(f.edits['ai-abcd1234']).toEqual({ body: 'ai edit' });
      expect(f.mine[0]?.body).toBe('my edit');
      if (!opts.updateError) expect(write.updateComment).not.toHaveBeenCalled();
    });

    it.each<[string, Opts]>([
      ['auth fails on the check', { comment: new AppError('GH_NOT_AUTHENTICATED') }],
      ['the network fails on the check', { comment: new AppError('EXEC_FAILED') }],
      ['auth fails on the update', { updateError: new AppError('GH_NOT_AUTHENTICATED') }],
      ['a timeout on the update', { updateError: new AppError('TIMEOUT') }],
    ])('writes nothing when %s', async (_, opts) => {
      const { svc, link, file } = make(opts);
      await link('ai-abcd1234', 'posted');
      const before = await file();
      await expect(svc.editNote(key, 'ai-abcd1234', 'new')).rejects.toBeInstanceOf(AppError);
      expect(await file()).toEqual(before);
    });

    it('edits only locally for a note promoted before links existed', async () => {
      const { svc, write, notes, file } = make();
      await notes.patchState(subject, 'ai-abcd1234', { promoted: true });
      const r = await svc.editNote(key, 'ai-abcd1234', 'new');
      expect(r.synced).toBe('local');
      expect((await file()).state['ai-abcd1234']).toEqual({ promoted: true });
      noGitHub(write);
    });

    it('needs the target to be open in main', async () => {
      const { svc } = make();
      await expect(svc.editNote(`acme/api#812@${'d'.repeat(40)}`, 'ai-abcd1234', 'x')).rejects.toThrow(
        /Open the pull request/,
      );
    });
  });
});
