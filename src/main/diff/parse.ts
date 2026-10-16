import picomatch from 'picomatch';
import type { DiffFile, DiffHunk, DiffLine, DiffModel } from '../../shared/diff';

type RawLine = Omit<DiffLine, 'id'>;
type RawFile = Omit<DiffFile, 'fid' | 'noise' | 'hunks'> & {
  hunks: { header: string; lines: RawLine[] }[];
};

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses `git diff` / `gh pr diff` output. Line IDs are assigned separately by `assignLineIds`. */
export function parseUnifiedDiff(text: string): RawFile[] {
  const files: RawFile[] = [];
  let file: RawFile | null = null;
  let hunk: RawFile['hunks'][number] | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const paths = parseGitHeader(line);
      file = {
        path: paths?.b ?? '',
        oldPath: paths?.a,
        status: 'modified',
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (hunk) {
      const c = line[0];
      if (c === '+' || c === '-' || c === ' ') {
        const text = line.slice(1);
        if (c === '+') {
          hunk.lines.push({ kind: 'add', new: newNo++, text });
          file.additions++;
        } else if (c === '-') {
          hunk.lines.push({ kind: 'del', old: oldNo++, text });
          file.deletions++;
        } else {
          hunk.lines.push({ kind: 'ctx', old: oldNo++, new: newNo++, text });
        }
        continue;
      }
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    }

    const h = HUNK.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    hunk = null;
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      file.status = 'renamed';
      file.oldPath = unquote(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) file.path = unquote(line.slice('rename to '.length));
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
    else if (line.startsWith('--- ') && file.status === 'deleted') {
      file.path = stripPrefix(unquote(line.slice(4)), 'a/') ?? file.path;
    } else if (line.startsWith('+++ ') && !line.endsWith('/dev/null')) {
      file.path = stripPrefix(unquote(line.slice(4)), 'b/') ?? file.path;
    }
  }

  for (const f of files) {
    if (f.status !== 'renamed') delete f.oldPath;
  }
  return files.filter((f) => f.path);
}

/**
 * Sorts files by path, numbers them F1…Fn (noise included, so IDs never shift when globs
 * change what is reviewed), and numbers every line within a file across hunks.
 */
export function assignLineIds(raw: readonly RawFile[], noiseGlobs: readonly string[]): DiffModel {
  const isNoise = noiseMatcher(noiseGlobs);
  const sorted = [...raw].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    files: sorted.map((f, i) => {
      const fid = `F${i + 1}`;
      let ord = 0;
      const hunks: DiffHunk[] = f.hunks.map((h) => ({
        header: h.header,
        lines: h.lines.map((l) => ({ id: `${fid}-${String(++ord).padStart(3, '0')}`, ...l })),
      }));
      return { ...f, fid, hunks, noise: isNoise(f.path) };
    }),
  };
}

export function buildDiffModel(text: string, noiseGlobs: readonly string[]): DiffModel {
  return assignLineIds(parseUnifiedDiff(text), noiseGlobs);
}

/** Returns the first glob that matches a path, or null. */
export function noiseMatcher(globs: readonly string[]): (path: string) => string | null {
  const matchers = globs.map((g) => [g, picomatch(g, { dot: true })] as const);
  return (path) => matchers.find(([, m]) => m(path))?.[0] ?? null;
}

function parseGitHeader(line: string): { a: string; b: string } | null {
  const rest = line.slice('diff --git '.length);
  const quoted = /^"a\/((?:[^"\\]|\\.)*)" "b\/((?:[^"\\]|\\.)*)"$/.exec(rest);
  if (quoted) return { a: unescapeC(quoted[1] ?? ''), b: unescapeC(quoted[2] ?? '') };
  // Unquoted: "a/x b/x". Paths with spaces are ambiguous here; the +++ line settles them.
  const m = /^a\/(.*) b\/(.*)$/.exec(rest);
  return m ? { a: m[1] ?? '', b: m[2] ?? '' } : null;
}

function stripPrefix(path: string, prefix: string): string | null {
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

function unquote(s: string): string {
  const t = s.replace(/\t.*$/, '');
  return t.startsWith('"') && t.endsWith('"') ? unescapeC(t.slice(1, -1)) : t;
}

/** git C-quotes unusual paths, with octal escapes for non-ASCII bytes. */
function unescapeC(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] ?? '';
    if (ch !== '\\') {
      bytes.push(...new TextEncoder().encode(ch));
      continue;
    }
    const next = s[i + 1] ?? '';
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(
        ({ n: 10, t: 9, '"': 34, '\\': 92 } as Record<string, number>)[next] ?? next.charCodeAt(0),
      );
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
