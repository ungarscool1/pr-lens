import type { DiffModel } from '../../shared/diff';

// Kept apart from analysis.ts so the main process can use these without loading the compiler.

/** Bump when the analysis changes what it finds; persisted maps from older versions are a miss. */
export const ANALYZER_VERSION = 4;

/** Changed declarations expanded into the graph; the rest are counted, not drawn. */
export const MAX_CHANGED_FUNCTIONS = 60;

const SOURCE_FILE = /\.[cm]?[jt]sx?$/i;
const NOT_SOURCE =
  /(?:^|\/)(?:node_modules|dist|build|out|vendor|coverage)\/|\.d\.[cm]?ts$|\.min\.[cm]?js$/i;
const TEST_FILE = /(?:^|\/)(?:__tests__|test|tests)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

export const isImpactSource = (path: string): boolean =>
  SOURCE_FILE.test(path) && !NOT_SOURCE.test(path);
export const isTestPath = (path: string): boolean => TEST_FILE.test(path);
export const isConfigPath = (path: string): boolean =>
  /^(?:tsconfig(?:\.[\w-]+)?|jsconfig)\.json$/.test(path);

export interface ChangedLine {
  /** Line in the new file; a deletion sits on the line that now follows it. */
  line: number;
  lineId: string;
}

/** Added and deleted lines per file, in new-file coordinates. Context lines never count. */
export function changedLines(
  diff: DiffModel,
  isSource: (path: string) => boolean = isImpactSource,
): Map<string, ChangedLine[]> {
  const result = new Map<string, ChangedLine[]>();
  for (const file of diff.files) {
    if (!isSource(file.path) || file.binary || file.status === 'deleted') continue;
    const lines: ChangedLine[] = [];
    for (const hunk of file.hunks) {
      let lastNew = 0;
      const pendingDeletes: string[] = [];
      for (const line of hunk.lines) {
        if (line.new !== undefined) {
          for (const lineId of pendingDeletes.splice(0)) lines.push({ line: line.new, lineId });
          if (line.kind === 'add') lines.push({ line: line.new, lineId: line.id });
          lastNew = line.new;
        } else if (line.kind === 'del') {
          pendingDeletes.push(line.id);
        }
      }
      for (const lineId of pendingDeletes) lines.push({ line: Math.max(1, lastNew), lineId });
    }
    if (lines.length)
      result.set(
        file.path,
        lines.sort((a, b) => a.line - b.line),
      );
  }
  return result;
}
