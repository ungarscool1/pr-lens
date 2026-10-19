import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AppError } from '../../shared/errors';

export interface ExecRequest {
  file: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, then stdin is closed. Large prompts go here instead of argv. */
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBufferBytes?: number;
  /** `latin1` maps each output byte to one char, for callers that frame output by byte counts. */
  encoding?: 'utf8' | 'latin1';
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Exit code. Non-zero exits resolve; only spawn failures, timeouts and aborts reject. */
  code: number;
}

export type Exec = (req: ExecRequest) => Promise<ExecResult>;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/** The only place PR Lens starts a process. execFile, never a shell string. */
export const execFileRunner: Exec = (req) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      req.file,
      req.args,
      {
        cwd: req.cwd,
        env: req.env,
        timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: req.signal,
        maxBuffer: req.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
        encoding: req.encoding ?? 'utf8',
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, code: 0 });
        const name = commandName(req.file);
        if (req.signal?.aborted) return reject(new AppError('CANCELLED'));
        if (err.code === 'ENOENT' || err.code === 'EACCES') {
          return reject(
            new AppError('BIN_NOT_FOUND', `Could not run ${name}. Check its path in Settings.`),
          );
        }
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return reject(
            new AppError('EXEC_FAILED', `${name} produced more output than PR Lens accepts.`),
          );
        }
        if (err.killed)
          return reject(new AppError('TIMEOUT', `${name} took too long and was stopped.`));
        if (typeof err.code === 'number') return resolve({ stdout, stderr, code: err.code });
        reject(new AppError('EXEC_FAILED', `${name} failed to start.`, { cause: err }));
      },
    );
    // A child that exits before reading stdin raises EPIPE here; the exit callback reports it.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(req.input ?? '');
  });

const commandName = (file: string): string => file.split('/').pop() ?? file;

export interface SpawnRequest {
  file: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

export type SpawnStdio = (req: SpawnRequest) => ChildProcessWithoutNullStreams;

/**
 * A long-lived child spoken to over stdin/stdout (a language server). Same rules as execFile:
 * no shell, explicit env, and the signal kills it.
 */
export const spawnStdio: SpawnStdio = (req) =>
  spawn(req.file, req.args, {
    cwd: req.cwd,
    env: req.env,
    signal: req.signal,
    stdio: 'pipe',
    windowsHide: true,
  });
