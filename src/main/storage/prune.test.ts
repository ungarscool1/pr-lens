import { mkdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { pruneDirectories } from './prune';

describe('pruneDirectories', () => {
  it('removes old folders and least-recent folders over the cap, while preserving active ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr-lens-prune-'));
    const old = join(root, 'old');
    const active = join(root, 'active');
    const recent = join(root, 'recent');
    const newest = join(root, 'newest');
    await Promise.all([
      mkdir(old),
      mkdir(active),
      mkdir(recent),
      mkdir(newest),
      writeFile(join(root, 'file'), ''),
    ]);
    const now = Date.now();
    const yesterday = new Date(now - 24 * 60 * 60 * 1000);
    const recentTime = new Date(now - 2_000);
    const newestTime = new Date(now - 1_000);
    await Promise.all([
      utimes(old, yesterday, yesterday),
      utimes(active, yesterday, yesterday),
      utimes(recent, recentTime, recentTime),
      utimes(newest, newestTime, newestTime),
    ]);

    await pruneDirectories(root, {
      maxAgeMs: 60 * 60 * 1000,
      maxEntries: 1,
      preserve: async (path) => path === active,
    });

    await expect(stat(old)).rejects.toThrow();
    await expect(stat(active)).resolves.toBeDefined();
    await expect(stat(newest)).resolves.toBeDefined();
    await expect(stat(recent)).rejects.toThrow();
    await expect(stat(join(root, 'file'))).resolves.toBeDefined();
  });
});
