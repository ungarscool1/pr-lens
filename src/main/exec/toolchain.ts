import { homedir } from 'node:os';
import { AppError } from '../../shared/errors';
import type { Exec } from './exec';
import { findBin, loginShellPath, searchPath } from './resolve-bin';

export interface Toolchain {
  gh: string | null;
  claude: string | null;
  /** Only needed for direct (two-dot) compare diffs. */
  git: string | null;
  /** PATH handed to children, so `claude` and `gh` can find git, node, etc. */
  path: string;
}

export interface ToolchainService {
  get(): Promise<Toolchain>;
  /** Forget the cached resolution (after a settings change or "Re-check"). */
  reset(): void;
}

export function createToolchain(
  exec: Exec,
  overrides: () => { ghPath: string | null; claudePath: string | null },
): ToolchainService {
  let cached: Promise<Toolchain> | null = null;
  const resolve = async (): Promise<Toolchain> => {
    const dirs = searchPath(await loginShellPath(exec));
    const { ghPath, claudePath } = overrides();
    const [gh, claude, git] = await Promise.all([
      findBin('gh', dirs, ghPath),
      findBin('claude', dirs, claudePath),
      findBin('git', dirs, null),
    ]);
    return { gh, claude, git, path: dirs.join(':') };
  };
  return {
    get: () => (cached ??= resolve()),
    reset: () => {
      cached = null;
    },
  };
}

export function requireBin(path: string | null, name: 'gh' | 'claude'): string {
  if (path) return path;
  throw new AppError(
    'BIN_NOT_FOUND',
    name === 'gh'
      ? 'gh was not found. Install it (brew install gh) or set its path in Settings.'
      : 'claude was not found. Install Claude Code or set its path in Settings.',
  );
}

const BASE_ENV_KEYS = ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL'] as const;

function baseEnv(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: path, TERM: 'dumb', HOME: process.env.HOME ?? homedir() };
  for (const k of BASE_ENV_KEYS) if (process.env[k] !== undefined) env[k] ??= process.env[k];
  return env;
}

/** gh keeps its own config and keyring; pass through only its config location overrides. */
export function ghEnv(tc: Toolchain): NodeJS.ProcessEnv {
  const env = baseEnv(tc.path);
  for (const k of ['GH_CONFIG_DIR', 'GH_HOST', 'XDG_CONFIG_HOME']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  env.GH_PROMPT_DISABLED = '1';
  env.NO_COLOR = '1';
  return env;
}

/** git for the two-dot fetch: never prompt; gh (as credential helper) needs its own env too. */
export function gitEnv(tc: Toolchain): NodeJS.ProcessEnv {
  return { ...ghEnv(tc), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' };
}

/**
 * Allow-list only: API keys, alternate providers and GitHub tokens never reach claude.
 * The OAuth token (from `claude setup-token`) is optional; without it the existing login is used.
 */
export function claudeEnv(tc: Toolchain, oauthToken: string | null): NodeJS.ProcessEnv {
  const env = baseEnv(tc.path);
  if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
  if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  return env;
}
