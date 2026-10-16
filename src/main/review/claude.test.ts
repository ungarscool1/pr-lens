import { describe, expect, it } from 'vitest';
import type { Exec, ExecRequest } from '../exec/exec';
import type { ToolchainService } from '../exec/toolchain';
import { ModelOutput } from '../../shared/review';
import { createClaudeClient, parseEnvelope, reviewArgs } from './claude';

const structured = { summary: 's', files: [], reading_order: [], notes: [] };
const envelope = (over: object) =>
  JSON.stringify({
    type: 'result',
    is_error: false,
    structured_output: structured,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 1,
    },
    ...over,
  });

const toolchain: ToolchainService = {
  get: async () => ({ gh: null, claude: '/bin/claude', path: '/usr/bin' }),
  reset: () => undefined,
};

describe('parseEnvelope', () => {
  it('reads structured output and usage', () => {
    const r = parseEnvelope(envelope({}), ModelOutput);
    expect(r.output).toEqual(structured);
    expect(r.usage).toEqual({
      inputTokens: 111,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheCreationTokens: 1,
    });
  });

  it.each([
    ['not json', 'MODEL_BAD_JSON'],
    [envelope({ structured_output: { summary: 1 } }), 'MODEL_BAD_JSON'],
    [
      envelope({ is_error: true, result: 'Not logged in · Please run /login' }),
      'CLAUDE_NOT_LOGGED_IN',
    ],
    [envelope({ is_error: true, result: 'Overloaded' }), 'MODEL_ERROR'],
  ])('maps %s to %s', (stdout, code) =>
    expect(() => parseEnvelope(stdout, ModelOutput)).toThrow(expect.objectContaining({ code })),
  );
});

describe('reviewArgs', () => {
  it('disables every tool, MCP server and setting source', () => {
    const args = reviewArgs('sys', null);
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after('--tools')).toBe('');
    expect(after('--setting-sources')).toBe('');
    expect(after('--permission-mode')).toBe('dontAsk');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--no-session-persistence');
    expect(reviewArgs('sys', 'opus').at(-1)).toBe('--model=opus');
  });
});

describe('ClaudeClient.review', () => {
  const req = {
    prompt: 'PROMPT',
    systemPrompt: 'SYS',
    cwd: '/sandbox',
    model: null,
    timeoutMs: 1000,
    signal: new AbortController().signal,
  };

  it('sends the prompt on stdin from the sandbox dir', async () => {
    const calls: ExecRequest[] = [];
    const exec: Exec = async (r) => {
      calls.push(r);
      return { stdout: envelope({}), stderr: '', code: 0 };
    };
    await createClaudeClient(exec, toolchain, async () => null).review(req);
    expect(calls[0]).toMatchObject({ file: '/bin/claude', cwd: '/sandbox', input: 'PROMPT' });
    expect(calls[0]!.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('retries once on bad JSON, then gives up', async () => {
    let n = 0;
    const exec: Exec = async () => ({
      stdout: n++ === 0 ? '{}' : envelope({}),
      stderr: '',
      code: 0,
    });
    await expect(
      createClaudeClient(exec, toolchain, async () => null).review(req),
    ).resolves.toBeDefined();
    const bad: Exec = async () => ({ stdout: '{}', stderr: '', code: 0 });
    await expect(
      createClaudeClient(bad, toolchain, async () => null).review(req),
    ).rejects.toMatchObject({ code: 'MODEL_BAD_JSON' });
  });
});
