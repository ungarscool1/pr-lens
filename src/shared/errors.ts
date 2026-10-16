export const ERROR_CODES = [
  'BAD_INPUT',
  'BIN_NOT_FOUND',
  'GH_NOT_AUTHENTICATED',
  'CLAUDE_NOT_LOGGED_IN',
  'RATE_LIMITED',
  'CLAUDE_LIMIT',
  'NOT_FOUND',
  'DIFF_TOO_LARGE',
  'PR_TOO_LARGE',
  'MODEL_BAD_JSON',
  'MODEL_ERROR',
  'TIMEOUT',
  'CANCELLED',
  'EXEC_FAILED',
  'SECRET_STORE_UNAVAILABLE',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** What crosses the IPC boundary: no stack, no stderr dumps. */
export interface SerializedError {
  code: ErrorCode;
  message: string;
}

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  BAD_INPUT: 'The request was not valid.',
  BIN_NOT_FOUND: 'A required command-line tool was not found. Check the paths in Settings.',
  GH_NOT_AUTHENTICATED: 'gh is not logged in. Run `gh auth login` in a terminal, then re-check.',
  CLAUDE_NOT_LOGGED_IN: 'claude is not logged in. Run `claude` once in a terminal and log in.',
  RATE_LIMITED: 'GitHub rate limit reached. Try again in a few minutes.',
  CLAUDE_LIMIT: 'Claude usage limit reached. Try again when it resets.',
  NOT_FOUND: 'That pull request was not found, or your gh account cannot see it.',
  DIFF_TOO_LARGE: 'GitHub refused to return this diff because it is too large.',
  PR_TOO_LARGE: 'This pull request is too large for a single review pass.',
  MODEL_BAD_JSON: 'Claude returned output that did not match the review schema.',
  MODEL_ERROR: 'The Claude review pass failed.',
  TIMEOUT: 'The command took too long and was stopped.',
  CANCELLED: 'Cancelled.',
  EXEC_FAILED: 'A command-line tool failed.',
  SECRET_STORE_UNAVAILABLE: 'Secure storage is not available on this system.',
  INTERNAL: 'Something went wrong inside PR Lens.',
};

export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? DEFAULT_MESSAGES[code], options);
    this.name = 'AppError';
    this.code = code;
  }

  toJSON(): SerializedError {
    return { code: this.code, message: this.message };
  }

  static from(err: unknown): AppError {
    if (err instanceof AppError) return err;
    return new AppError('INTERNAL', undefined, { cause: err });
  }

  static fromJSON(e: SerializedError): AppError {
    return new AppError(e.code, e.message);
  }
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: SerializedError };
