import { z } from 'zod';
import { AppError } from '../../shared/errors';
import type { Health } from '../../shared/health';
import { MergeOutput, ModelOutput, ReleaseOutput } from '../../shared/review';
import type { Usage } from '../../shared/review';
import type { Exec } from '../exec/exec';
import { claudeEnv, requireBin } from '../exec/toolchain';
import type { ToolchainService } from '../exec/toolchain';

export interface ClaudeRunRequest {
  prompt: string;
  systemPrompt: string;
  /** An empty directory: no repository-controlled CLAUDE.md or settings are loaded from cwd. */
  cwd: string;
  /** Optional repository snapshot exposed through read/search tools, never Bash or write tools. */
  repositoryDir?: string;
  model: string | null;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface ClaudeRunResult<T> {
  output: T;
  usage: Usage;
}

export interface ClaudeClient {
  health(): Promise<Health['claude']>;
  /** One chunk's review pass (review.v1). */
  review(req: ClaudeRunRequest): Promise<ClaudeRunResult<ModelOutput>>;
  /** The merge pass over validated chunk candidates (merge.v1). */
  merge(req: ClaudeRunRequest): Promise<ClaudeRunResult<MergeOutput>>;
  /** The release summary for a tag-to-tag compare (release.v1). */
  release(req: ClaudeRunRequest): Promise<ClaudeRunResult<ReleaseOutput>>;
}

const jsonSchemaOf = (schema: z.ZodType): string =>
  JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7' }));
export const REVIEW_JSON_SCHEMA = jsonSchemaOf(ModelOutput);
export const MERGE_JSON_SCHEMA = jsonSchemaOf(MergeOutput);
export const RELEASE_JSON_SCHEMA = jsonSchemaOf(ReleaseOutput);

const Envelope = z.object({
  is_error: z.boolean(),
  subtype: z.string().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  usage: z
    .object({
      input_tokens: z.number().default(0),
      output_tokens: z.number().default(0),
      cache_read_input_tokens: z.number().default(0),
      cache_creation_input_tokens: z.number().default(0),
    })
    .optional(),
});

const AuthStatus = z.object({ loggedIn: z.boolean(), authMethod: z.string().optional() });

/** Flags for the automatic pass: no tools, no MCP, no settings, no session left behind. */
export function reviewArgs(
  systemPrompt: string,
  model: string | null,
  jsonSchema: string = REVIEW_JSON_SCHEMA,
  repositoryDir?: string,
): string[] {
  return [
    '-p',
    '--system-prompt',
    systemPrompt,
    '--output-format',
    'json',
    '--json-schema',
    jsonSchema,
    '--tools',
    repositoryDir ? 'Read,Glob,Grep' : '',
    ...(repositoryDir ? [`--add-dir=${repositoryDir}`] : []),
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    '--max-turns',
    '3',
    ...(model ? [`--model=${model}`] : []),
  ];
}

export function parseEnvelope<T>(stdout: string, schema: z.ZodType<T>): ClaudeRunResult<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new AppError('MODEL_BAD_JSON', 'claude did not return a JSON envelope.');
  }
  const env = Envelope.safeParse(raw);
  if (!env.success) throw new AppError('MODEL_BAD_JSON', 'claude returned an unexpected envelope.');
  if (env.data.is_error) {
    const msg = env.data.result ?? '';
    if (/log ?in|not logged|authenticat|oauth/i.test(msg))
      throw new AppError('CLAUDE_NOT_LOGGED_IN');
    // e.g. "You've hit your session limit · resets 8pm": say so, including when it resets.
    if (/usage limit|session limit|weekly limit|rate limit|hit your .*limit/i.test(msg)) {
      throw new AppError('CLAUDE_LIMIT', `Claude usage limit reached: ${msg.slice(0, 160)}`);
    }
    throw new AppError(
      'MODEL_ERROR',
      `Claude review failed: ${msg.slice(0, 200) || env.data.subtype || 'unknown error'}`,
    );
  }
  const out = schema.safeParse(env.data.structured_output);
  if (!out.success) throw new AppError('MODEL_BAD_JSON');
  const u = env.data.usage;
  return {
    output: out.data,
    usage: {
      inputTokens:
        (u?.input_tokens ?? 0) +
        (u?.cache_read_input_tokens ?? 0) +
        (u?.cache_creation_input_tokens ?? 0),
      outputTokens: u?.output_tokens ?? 0,
      cacheReadTokens: u?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
    },
  };
}

function parseAuthStatus(stdout: string): z.infer<typeof AuthStatus> | null {
  try {
    return AuthStatus.parse(JSON.parse(stdout));
  } catch {
    return null;
  }
}

export function createClaudeClient(
  exec: Exec,
  toolchain: ToolchainService,
  oauthToken: () => Promise<string | null>,
): ClaudeClient {
  const structured = async <T>(
    req: ClaudeRunRequest,
    schema: z.ZodType<T>,
    jsonSchema: string,
  ): Promise<ClaudeRunResult<T>> => {
    const tc = await toolchain.get();
    const run = async (): Promise<ClaudeRunResult<T>> => {
      const res = await exec({
        file: requireBin(tc.claude, 'claude'),
        args: reviewArgs(req.systemPrompt, req.model, jsonSchema, req.repositoryDir),
        cwd: req.cwd,
        env: claudeEnv(tc, await oauthToken()),
        input: req.prompt,
        timeoutMs: req.timeoutMs,
        signal: req.signal,
      });
      // An error envelope can come with a non-zero exit; let the envelope explain itself.
      if (res.code !== 0 && !res.stdout.trim()) {
        throw new AppError('MODEL_ERROR', `claude exited with code ${res.code}.`);
      }
      return parseEnvelope(res.stdout, schema);
    };
    try {
      return await run();
    } catch (err) {
      // One retry for malformed output; everything else is final.
      if (err instanceof AppError && err.code === 'MODEL_BAD_JSON' && !req.signal.aborted)
        return run();
      throw err;
    }
  };

  return {
    async health() {
      const tc = await toolchain.get();
      const none = { loggedIn: false, authMethod: null, version: null };
      if (!tc.claude) {
        return {
          path: null,
          ...none,
          problem: 'claude not found. Install Claude Code, or set its path.',
        };
      }
      const env = claudeEnv(tc, await oauthToken().catch(() => null));
      const [ver, auth] = await Promise.all([
        exec({ file: tc.claude, args: ['--version'], env, timeoutMs: 15_000 }),
        exec({ file: tc.claude, args: ['auth', 'status'], env, timeoutMs: 15_000 }),
      ]);
      const version = /^(\S+)/.exec(ver.stdout.trim())?.[1] ?? null;
      const status = parseAuthStatus(auth.stdout);
      if (!status?.loggedIn) {
        return {
          path: tc.claude,
          ...none,
          version,
          problem: 'claude is not logged in. Run `claude` and log in.',
        };
      }
      return {
        path: tc.claude,
        version,
        loggedIn: true,
        authMethod: status.authMethod ?? null,
        problem: null,
      };
    },

    review: (req) => structured(req, ModelOutput, REVIEW_JSON_SCHEMA),
    merge: (req) => structured(req, MergeOutput, MERGE_JSON_SCHEMA),
    release: (req) => structured(req, ReleaseOutput, RELEASE_JSON_SCHEMA),
  };
}
