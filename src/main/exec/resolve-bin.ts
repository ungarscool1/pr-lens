import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Exec } from './exec';

export type IsExecutable = (path: string) => Promise<boolean>;

export const isExecutable: IsExecutable = (path) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  );

const MARK = '__PR_LENS_PATH__';

/**
 * macOS GUI apps get a minimal PATH, so ask the user's login shell for theirs.
 * The command string is a constant: nothing from the user is interpolated.
 */
export async function loginShellPath(
  exec: Exec,
  shell = process.env.SHELL,
): Promise<string | null> {
  if (!shell?.startsWith('/')) return null;
  try {
    const { stdout, code } = await exec({
      file: shell,
      args: ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`],
      timeoutMs: 5_000,
      env: { HOME: homedir(), USER: process.env.USER, TERM: 'dumb' },
    });
    if (code !== 0) return null;
    // Interactive shells may print banners around our output; take only what is between marks.
    return new RegExp(`${MARK}(.*?)${MARK}`, 's').exec(stdout)?.[1] ?? null;
  } catch {
    // A missing or slow shell just means we fall back to the well-known locations.
    return null;
  }
}

export function fallbackDirs(home = homedir()): string[] {
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.local/bin'),
    join(home, '.claude/local'),
    '/usr/bin',
    '/bin',
  ];
}

/** Login-shell PATH first, then fallbacks, de-duplicated. Also used as PATH for children. */
export function searchPath(loginPath: string | null, home = homedir()): string[] {
  const dirs = [...(loginPath?.split(delimiter) ?? []), ...fallbackDirs(home)];
  return [...new Set(dirs.filter((d) => d.startsWith('/')))];
}

export async function findBin(
  name: string,
  dirs: readonly string[],
  override: string | null,
  executable: IsExecutable = isExecutable,
): Promise<string | null> {
  if (override) return (await executable(override)) ? override : null;
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (await executable(candidate)) return candidate;
  }
  return null;
}
