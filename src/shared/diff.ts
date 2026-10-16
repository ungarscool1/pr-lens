export type LineKind = 'add' | 'del' | 'ctx';
export type Side = 'LEFT' | 'RIGHT';

export interface DiffLine {
  /** Stable anchor, e.g. `F1-007`: file ordinal + line ordinal across all hunks of that file. */
  id: string;
  kind: LineKind;
  old?: number;
  new?: number;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFile {
  /** `F1`…`Fn`, assigned in path order across the whole diff, noise files included. */
  fid: string;
  path: string;
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** The noise glob this file matched, or null if it is reviewed. */
  noise: string | null;
}

export interface DiffModel {
  files: DiffFile[];
}

export type NoiseKind = 'lockfile' | 'snapshot' | 'generated';

export function noiseKind(glob: string): NoiseKind {
  if (/lock|\.sum\b/i.test(glob)) return 'lockfile';
  if (/snap/i.test(glob)) return 'snapshot';
  return 'generated';
}
