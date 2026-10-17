import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface DirectoryPruneOptions {
  maxAgeMs: number;
  maxEntries: number;
  /** Protected folders are never removed, even when old or beyond the entry cap. */
  preserve?: (path: string) => Promise<boolean>;
}

/**
 * Bounds direct child folders owned by the app. It never follows links or traverses beyond
 * `root`; an unreadable entry is left untouched rather than risking deletion.
 */
export async function pruneDirectories(root: string, options: DirectoryPruneOptions): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(root, entry.name);
        try {
          return { path, mtime: (await stat(path)).mtimeMs, preserve: await options.preserve?.(path) };
        } catch {
          return null;
        }
      }),
  );
  const cutoff = Date.now() - options.maxAgeMs;
  const current = candidates
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => b.mtime - a.mtime);
  const expired = current.filter((entry) => !entry.preserve && entry.mtime < cutoff);
  const bounded = current
    .filter((entry) => !entry.preserve && entry.mtime >= cutoff)
    .slice(options.maxEntries);
  await Promise.all([...expired, ...bounded].map((entry) => rm(entry.path, { recursive: true, force: true })));
}
