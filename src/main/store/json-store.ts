import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import type { z } from 'zod';

export interface JsonStore {
  /** Missing or unreadable-as-schema files return the fallback; a corrupt file is never overwritten silently. */
  read<S extends z.ZodType>(name: string, schema: S, fallback: z.output<S>): Promise<z.output<S>>;
  write(name: string, value: unknown): Promise<void>;
}

export function createJsonStore(root: string): JsonStore {
  const resolve = (name: string): string => {
    const p = join(root, name);
    const rel = relative(root, p);
    if (rel.startsWith('..') || isAbsolute(rel))
      throw new Error(`Store path escapes root: ${name}`);
    return p;
  };
  // Serialize writes per file so concurrent updates cannot interleave.
  const queues = new Map<string, Promise<void>>();

  return {
    async read(name, schema, fallback) {
      let raw: string;
      try {
        raw = await readFile(resolve(name), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
        throw err;
      }
      const parsed = schema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error(`Stored file ${name} does not match its schema`);
      return parsed.data;
    },
    write(name, value) {
      const path = resolve(name);
      const prev = queues.get(path) ?? Promise.resolve();
      const next = prev.then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const tmp = `${path}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
        await rename(tmp, path);
      });
      queues.set(
        path,
        next.catch(() => undefined),
      );
      return next;
    },
  };
}
