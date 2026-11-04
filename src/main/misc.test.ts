import { describe, expect, it, vi } from 'vitest';
import { parsePrInput } from '../shared/pr';
import { AppError } from '../shared/errors';
import type { Exec } from './exec/exec';
import { findBin, loginShellPath, searchPath } from './exec/resolve-bin';
import { claudeEnv } from './exec/toolchain';
import { classifyGhError } from './github/gh';
import { createLimiter } from './review/limiter';
import { redactSecrets } from './review/secrets';
import { isAllowedExternalUrl } from '../shared/external';
import { contract } from '../shared/ipc';
import { NotesFile } from '../shared/notes';

describe('notes:edit input', () => {
  const schema = contract['notes:edit'].input;
  const ok = { targetKey: `acme/api#812@${'c'.repeat(40)}`, id: 'ai-abcd1234', body: 'x' };

  it('accepts a target key, a note ID and a body', () => {
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse({ ...ok, id: 'me-abcd1234', body: 'y'.repeat(65_000) }).success).toBe(
      true,
    );
  });

  it.each([
    ['an unknown key', { ...ok, commentId: 'PRRC_1' }],
    ['a published link', { ...ok, published: { commentId: 'PRRC_1', body: 'x' } }],
    ['an empty body', { ...ok, body: '' }],
    ['an oversized body', { ...ok, body: 'y'.repeat(65_001) }],
    ['a malformed note ID', { ...ok, id: 'xx-abcd1234' }],
    ['a too short note ID', { ...ok, id: 'ai-ab' }],
    ['a malformed target key', { ...ok, targetKey: 'acme/api' }],
    ['a missing body', { targetKey: ok.targetKey, id: ok.id }],
  ])('rejects %s', (_, input) => expect(schema.safeParse(input).success).toBe(false));

  it('keeps new private notes at 10,000 characters', () => {
    const note = {
      subject: { kind: 'pr', ref: { owner: 'acme', repo: 'api', number: 812 } },
      path: 'a.ts',
      side: 'RIGHT',
      line: 1,
      lineId: 'F1-001',
    };
    const create = contract['notes:create'].input;
    expect(create.safeParse({ ...note, body: 'y'.repeat(10_000) }).success).toBe(true);
    expect(create.safeParse({ ...note, body: 'y'.repeat(10_001) }).success).toBe(false);
  });

  it('parses an older notes file, with edits and links defaulting to empty', () => {
    expect(NotesFile.parse({ mine: [], state: {} })).toEqual({
      mine: [],
      state: {},
      edits: {},
      published: {},
    });
    expect(
      NotesFile.safeParse({
        mine: [],
        state: {},
        published: { 'ai-abcd1234': { commentId: 'bad id!', body: 'x' } },
      }).success,
    ).toBe(false);
  });
});

describe('parsePrInput', () => {
  it.each([
    ['https://github.com/acme/api/pull/812', { owner: 'acme', repo: 'api', number: 812 }],
    ['github.com/acme/api/pull/812/files?w=1', { owner: 'acme', repo: 'api', number: 812 }],
    ['  acme/my.repo#7 ', { owner: 'acme', repo: 'my.repo', number: 7 }],
  ])('%s', (input, ref) => expect(parsePrInput(input)).toEqual(ref));

  it.each([
    'acme/api',
    'https://gitlab.com/a/b/pull/1',
    '-x/api#1',
    'acme/..#1',
    'acme/api#0',
    'a b/c#1',
  ])('rejects %s', (input) => expect(parsePrInput(input)).toBeNull());
});

describe('classifyGhError', () => {
  it.each([
    ['To get started with GitHub CLI, please run:  gh auth login', 'GH_NOT_AUTHENTICATED'],
    ['HTTP 403: API rate limit exceeded for user', 'RATE_LIMITED'],
    ['HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)', 'DIFF_TOO_LARGE'],
    ["GraphQL: Could not resolve to a Repository with the name 'a/b'.", 'NOT_FOUND'],
    ['something odd', 'EXEC_FAILED'],
  ])('%s → %s', (stderr, code) => expect(classifyGhError(stderr).code).toBe(code));
});

describe('binary resolution', () => {
  it('extracts PATH from noisy login-shell output', async () => {
    const exec: Exec = async () => ({
      stdout: 'Welcome!\n__PR_LENS_PATH__/opt/homebrew/bin:/usr/bin__PR_LENS_PATH__',
      stderr: '',
      code: 0,
    });
    expect(await loginShellPath(exec, '/bin/zsh')).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('falls back when the shell fails', async () => {
    const exec: Exec = async () => {
      throw new AppError('TIMEOUT');
    };
    expect(await loginShellPath(exec, '/bin/zsh')).toBeNull();
  });

  it('searches login PATH first, then fallbacks, and honours overrides', async () => {
    const dirs = searchPath('/custom/bin:relative/bin', '/Users/me');
    expect(dirs.slice(0, 2)).toEqual(['/custom/bin', '/opt/homebrew/bin']);
    expect(dirs).toContain('/Users/me/.claude/local');
    const exists = (p: string) =>
      Promise.resolve(p === '/Users/me/.local/bin/claude' || p === '/x/claude');
    expect(await findBin('claude', dirs, null, exists)).toBe('/Users/me/.local/bin/claude');
    expect(await findBin('claude', dirs, '/x/claude', exists)).toBe('/x/claude');
    expect(await findBin('claude', dirs, '/missing', exists)).toBeNull();
  });
});

describe('claudeEnv', () => {
  it('never forwards API keys or provider switches', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-should-not-leak');
    vi.stubEnv('GITHUB_TOKEN', 'ghp_x');
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
    const env = claudeEnv({ gh: null, claude: '/c', git: null, path: '/usr/bin' }, 'oauth-token');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token');
    expect(env.PATH).toBe('/usr/bin');
    vi.unstubAllEnvs();
  });
});

describe('redactSecrets', () => {
  it('masks common formats', () => {
    const r = redactSecrets('key = AKIAABCDEFGHIJKLMNOP; const password = "hunter2hunter2!"');
    expect(r.text).toBe(
      'key = [REDACTED:aws-access-key]; const password = "[REDACTED:assigned-secret]"',
    );
    expect(r.kinds).toEqual(['aws-access-key', 'assigned-secret']);
  });

  it('leaves ordinary code alone', () => {
    const code = 'const token = req.cookies.refresh; if (!token) return null;';
    expect(redactSecrets(code)).toEqual({ text: code, kinds: [] });
  });
});

describe('isAllowedExternalUrl', () => {
  it.each([
    ['https://github.com/acme/api/pull/812', true],
    ['http://github.com/acme', false],
    ['https://github.com.evil.io/', false],
    ['https://user@github.com/', false],
    ['javascript:alert(1)', false],
    ['file:///etc/passwd', false],
  ])('%s → %s', (url, ok) => expect(isAllowedExternalUrl(url)).toBe(ok));
});

describe('createLimiter', () => {
  it('never runs more than max tasks at once', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      limit(async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });

  it('frees the slot when a task fails', async () => {
    const limit = createLimiter(1);
    await expect(limit(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(limit(() => Promise.resolve(1))).resolves.toBe(1);
  });
});
