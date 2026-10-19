import { chmod, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Clears every execute bit in a checkout PR Lens made for language servers. Nothing there needs
 * to run, so a PR that ships, say, `.venv/bin/python` for a server to call gets EACCES instead.
 * Symbolic links are skipped: chmod would follow them out of the checkout.
 */
export async function stripExecutableBits(root: string): Promise<void> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((e) => join(e.parentPath, e.name));
  for (let i = 0; i < files.length; i += 64) {
    await Promise.all(
      files.slice(i, i + 64).map(async (path) => {
        const { mode } = await lstat(path);
        if (mode & 0o111) await chmod(path, mode & 0o7666);
      }),
    );
  }
}
