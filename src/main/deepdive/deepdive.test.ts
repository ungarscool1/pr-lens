import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { Header } from '../../shared/ipc';
import type { PrMeta } from '../../shared/pr';
import type { Analysis } from '../../shared/review';
import { Settings } from '../../shared/settings';
import type { Subject } from '../../shared/subject';
import { SAMPLE_DIFF } from '../diff/fixtures';
import { buildDiffModel } from '../diff/parse';
import type { Exec, ExecRequest } from '../exec/exec';
import type { NotesService } from '../notes/notes';
import type { AnalysisCache } from '../review/cache';
import type { LoadedTarget } from '../review/service';
import type { SettingsService } from '../settings/settings';
import { createDeepDive } from './deepdive';
import { contextMarkdown, firstMessage, launchScript, shellQuote, worktreeName } from './session';
import type { DeepDiveNote } from './session';

const HEAD = '9bd04e1' + 'a'.repeat(33);
const subject: Subject = { kind: 'pr', ref: { owner: 'acme', repo: 'api', number: 812 } };
const meta: PrMeta = {
  url: 'https://github.com/acme/api/pull/812',
  title: 'Cache sessions $(touch PWNED) `id` "x"',
  body: 'Users get logged out. token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"',
  state: 'OPEN',
  isDraft: false,
  author: 'maria-k',
  baseRefName: 'main',
  headRefName: 'feat',
  baseSha: '3f2a91c' + 'b'.repeat(33),
  headSha: HEAD,
  commitCount: 3,
  linkedIssues: [],
};
const header: Header = { kind: 'pr', meta };
const diff = buildDiffModel(SAMPLE_DIFF, []);
const note: DeepDiveNote = {
  label: '[high · security]',
  title: "Memo can serve revoked sessions; rm -rf ~ 'q'",
  body: 'memo is never evicted.',
  question: 'How is memo invalidated?',
  path: 'src/auth/session.ts',
  side: 'RIGHT',
  startLine: 40,
  endLine: 42,
};

describe('session builders', () => {
  it('names worktrees per subject and head', () => {
    expect(worktreeName(subject, HEAD)).toBe('acme__api__pr812__9bd04e1');
    expect(
      worktreeName(
        {
          kind: 'compare',
          owner: 'cli',
          repo: 'cli',
          baseSha: 'a'.repeat(40),
          headSha: HEAD,
          mode: 'three-dot',
        },
        HEAD,
      ),
    ).toBe('cli__cli__cmp__9bd04e1');
  });

  it('writes a first message that points at the context file', () => {
    const m = firstMessage(subject, header, HEAD, note, '/s/pr.md');
    expect(m).toContain('I am reviewing acme/api#812');
    expect(m).toContain('[high · security] Memo can serve revoked sessions');
    expect(m).toContain('at src/auth/session.ts:40-42');
    expect(m).toContain('/s/pr.md');
    expect(m).toContain('Do not modify files.');
  });

  it('puts the note, description and the file diff in the context, with secrets masked', () => {
    const md = contextMarkdown(
      subject,
      header,
      HEAD,
      note,
      diff.files.find((f) => f.path === note.path),
      diff.files,
    );
    expect(md).toContain('## The note');
    expect(md).toContain('Question for the author: How is memo invalidated?');
    expect(md).toContain('## Diff of src/auth/session.ts');
    expect(md).toContain('+  const session = (await store.get(token)) ?? memo.get(token);');
    expect(md).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('quotes for sh', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe('launch script', () => {
  it('runs claude in the worktree, read-only flags, message from the file, nothing from the PR executed', async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr lens's-"));
    const worktree = join(dir, 'wt');
    const sessionDir = join(dir, 'session');
    await import('node:fs/promises').then((fs) =>
      Promise.all([fs.mkdir(worktree), fs.mkdir(sessionDir)]),
    );
    const fakeClaude = join(dir, 'claude');
    await writeFile(
      fakeClaude,
      `#!/bin/sh\npwd -P > "${join(dir, 'cwd.txt')}"\nprintf '%s\\n' "$@" > "${join(dir, 'argv.txt')}"\nprintf '%s' "\${ANTHROPIC_API_KEY-unset}" > "${join(dir, 'key.txt')}"\n`,
    );
    await chmod(fakeClaude, 0o755);
    const messageFile = join(sessionDir, 'first-message.txt');
    await writeFile(
      messageFile,
      firstMessage(subject, header, HEAD, note, join(sessionDir, 'pr.md')),
    );
    const script = join(sessionDir, 'launch.command');
    await writeFile(
      script,
      launchScript({ worktree, claude: fakeClaude, sessionDir, messageFile }),
    );

    await promisify(execFile)('/bin/sh', [script], {
      cwd: dir,
      env: { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-ant-leak' },
    });

    expect((await readFile(join(dir, 'cwd.txt'), 'utf8')).trim()).toBe(
      await import('node:fs/promises').then((fs) => fs.realpath(worktree)),
    );
    const argv = (await readFile(join(dir, 'argv.txt'), 'utf8')).split('\n');
    expect(argv.slice(0, 6)).toEqual([
      '--permission-mode',
      'plan',
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      `--add-dir=${sessionDir}`,
    ]);
    expect(argv.slice(6).join('\n')).toContain('Cache sessions $(touch PWNED) `id` "x"');
    expect(await readFile(join(dir, 'key.txt'), 'utf8')).toBe('unset');
    await expect(stat(join(sessionDir, '.active'))).rejects.toThrow();
    await expect(stat(join(dir, 'PWNED'))).rejects.toThrow();
    await expect(stat(join(worktree, 'PWNED'))).rejects.toThrow();
  });
});

describe('deep dive service', () => {
  const analysis = (): Analysis => ({
    targetKey: `acme/api#812@${HEAD}`,
    headSha: HEAD,
    promptVersion: 'review.v1',
    summary: '',
    files: [],
    readingOrder: [],
    notes: [
      {
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
        body: 'b',
        refs: [],
        confidence: 0.8,
        score: 2.9,
        repaired: false,
      },
    ],
    dropped: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    chunks: 1,
    failedChunks: 0,
    merge: 'none',
    redactions: [],
    createdAt: 0,
  });
  const make = async (platform: NodeJS.Platform = 'darwin', openCode = 0) => {
    const calls: ExecRequest[] = [];
    const exec: Exec = async (r) => {
      calls.push(r);
      return { stdout: '', stderr: '', code: openCode };
    };
    const sessionsDir = await mkdtemp(join(tmpdir(), 'pr-lens-dd-'));
    const loaded: LoadedTarget = {
      target: { key: `acme/api#812@${HEAD}`, subject, headSha: HEAD },
      header,
      diff,
      context: { tag: 'pr', attrs: {}, title: '', description: '', sections: [] },
    };
    const settings = Settings.parse({ terminalApp: 'iTerm' });
    const worktree = vi.fn(async () => '/wt/acme__api__pr812__9bd04e1');
    const svc = createDeepDive({
      exec,
      toolchain: {
        get: async () => ({ gh: '/gh', claude: '/bin/claude', git: '/git', path: '' }),
        reset: () => undefined,
      },
      git: {
        directDiff: () => Promise.reject(new Error('unused')),
        worktree,
        treeEntries: () => Promise.reject(new Error('unused')),
        sourceFiles: () => Promise.reject(new Error('unused')),
        filesAt: () => Promise.reject(new Error('unused')),
      },
      review: { loaded: (k) => (k === loaded.target.key ? loaded : undefined) },
      cache: {
        get: async () => ({ analysis: analysis(), stale: false }),
      } as unknown as AnalysisCache,
      notes: { list: async () => ({ mine: [], state: {} }) } as unknown as NotesService,
      settings: { current: () => settings } as unknown as SettingsService,
      sessionsDir,
      platform,
    });
    return { svc, calls, worktree, key: loaded.target.key };
  };

  it('creates the worktree, writes the session files and opens the terminal app', async () => {
    const { svc, calls, worktree, key } = await make();
    const r = await svc.open(key, 'ai-abcd1234');
    expect(worktree).toHaveBeenCalledWith(
      { owner: 'acme', repo: 'api' },
      HEAD,
      'acme__api__pr812__9bd04e1',
    );
    expect(calls).toEqual([
      expect.objectContaining({ file: '/usr/bin/open', args: ['-a', 'iTerm', r.scriptPath] }),
    ]);
    expect((await stat(r.scriptPath)).mode & 0o777).toBe(0o700);
    const script = await readFile(r.scriptPath, 'utf8');
    expect(script).toContain(`cd '/wt/acme__api__pr812__9bd04e1'`);
    expect(await readFile(join(r.scriptPath, '..', 'first-message.txt'), 'utf8')).toContain(
      '[high · security] Memo can serve revoked sessions',
    );
  });

  it('explains unknown notes, other platforms and a terminal that does not open', async () => {
    const { svc, key } = await make();
    await expect(svc.open(key, 'ai-nope0000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.open('acme/api#1@' + HEAD, 'ai-abcd1234')).rejects.toMatchObject({
      code: 'BAD_INPUT',
    });
    await expect((await make('linux')).svc.open(key, 'ai-abcd1234')).rejects.toMatchObject({
      message: expect.stringContaining('macOS'),
    });
    await expect((await make('darwin', 1)).svc.open(key, 'ai-abcd1234')).rejects.toMatchObject({
      code: 'EXEC_FAILED',
      message: expect.stringContaining('sh '),
    });
  });
});
