import { useCallback, useRef, useState } from 'react';
import type { DiffFile } from '../../../../shared/diff';
import { api, errorMessage, run } from '../../lib/api';
import { expandReveal, gapsOf, revealRange } from './expand';
import type { ExpandDir, Reveals } from './expand';

/** One file's unchanged lines around its hunks: the head text once loaded, and what is revealed. */
export interface FileExpansion {
  lines: readonly string[] | null;
  loading: boolean;
  error: string | null;
  reveals: Reveals;
}

const NONE: Readonly<Record<string, FileExpansion>> = {};
const EMPTY: FileExpansion = { lines: null, loading: false, error: null, reveals: {} };

/**
 * Expansion state per file of one loaded target. A file's head text is fetched once, on its first
 * expand; a new target starts over.
 */
export function useExpansion(targetKey: string) {
  const [state, setState] = useState<{ key: string; files: Record<string, FileExpansion> }>({
    key: targetKey,
    files: {},
  });
  const requests = useRef(new Map<string, Promise<readonly string[] | null>>());

  const update = useCallback(
    (fid: string, fn: (cur: FileExpansion) => FileExpansion) =>
      setState((s) => {
        const files = s.key === targetKey ? s.files : {};
        return { key: targetKey, files: { ...files, [fid]: fn(files[fid] ?? EMPTY) } };
      }),
    [targetKey],
  );

  /** The file's lines, fetched at most once per target; null when that failed. */
  const load = useCallback(
    (fid: string): Promise<readonly string[] | null> => {
      const id = `${targetKey}:${fid}`;
      const pending = requests.current.get(id);
      if (pending) return pending;
      update(fid, (cur) => ({ ...cur, loading: true, error: null }));
      const request = run(api.diff.fileLines({ targetKey, fid })).then(
        ({ lines }) => {
          update(fid, (cur) => ({ ...cur, lines, loading: false }));
          return lines;
        },
        (e: unknown) => {
          requests.current.delete(id); // the next click retries
          update(fid, (cur) => ({ ...cur, loading: false, error: errorMessage(e) }));
          return null;
        },
      );
      requests.current.set(id, request);
      return request;
    },
    [targetKey, update],
  );

  const expand = useCallback(
    (fid: string, gap: number, dir: ExpandDir): void => {
      update(fid, (cur) => ({
        ...cur,
        reveals: { ...cur.reveals, [gap]: expandReveal(cur.reveals[gap], dir) },
      }));
      void load(fid);
    },
    [load, update],
  );

  /** Reveals new-side lines `from`…`to` of a file; resolves false if its text could not load. */
  const reveal = useCallback(
    async (file: DiffFile, from: number, to: number): Promise<boolean> => {
      const lines = await load(file.fid);
      if (!lines) return false;
      update(file.fid, (cur) => ({
        ...cur,
        reveals: revealRange(gapsOf(file, lines.length), cur.reveals, from, to),
      }));
      return true;
    },
    [load, update],
  );

  return { expansions: state.key === targetKey ? state.files : NONE, expand, reveal };
}
