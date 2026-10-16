import type { DiffFile, DiffHunk, DiffModel } from '../../shared/diff';

/** A whole file, or only some of its hunks (by index) when the file alone is over budget. */
export interface ChunkItem {
  fid: string;
  hunks: number[] | null;
}

export interface Chunk {
  items: ChunkItem[];
  tokens: number;
}

// Matches prompt.ts: chars ÷ 3.6, plus the "F12-345 + " prefix on every diff line.
const CHARS_PER_TOKEN = 3.6;
const LINE_PREFIX_CHARS = 10;

const hunkTokens = (h: DiffHunk): number =>
  (h.header.length + h.lines.reduce((n, l) => n + l.text.length + LINE_PREFIX_CHARS, 0)) /
  CHARS_PER_TOKEN;
const fileHeaderTokens = (f: DiffFile): number => (f.path.length + 40) / CHARS_PER_TOKEN;

export const isTestPath = (p: string): boolean =>
  /(\.(test|spec)\.[^/]+$)|(_test\.[^/]+$)|(^|\/)(__tests__|tests?)\//.test(p);

/** `src/auth/session.test.ts` and `src/auth/session.ts` share the stem `session`. */
const stem = (p: string): string =>
  (p.split('/').pop() ?? p).replace(/\.(test|spec)(?=\.)|_test(?=\.)/, '').replace(/\..*$/, '');
const topDir = (p: string): string => (p.includes('/') ? (p.split('/')[0] ?? '') : '');

interface Unit {
  fid: string;
  path: string;
  hunks: number[] | null;
  tokens: number;
}

/** Splits a file into units under budget; a single hunk over budget still goes alone. */
function unitsOf(f: DiffFile, budget: number): Unit[] {
  const head = fileHeaderTokens(f);
  const costs = f.hunks.map(hunkTokens);
  const total = head + costs.reduce((a, b) => a + b, 0);
  if (total <= budget) return [{ fid: f.fid, path: f.path, hunks: null, tokens: total }];
  const units: Unit[] = [];
  let cur: number[] = [];
  let curTokens = head;
  costs.forEach((c, i) => {
    if (cur.length && curTokens + c > budget) {
      units.push({ fid: f.fid, path: f.path, hunks: cur, tokens: curTokens });
      cur = [];
      curTokens = head;
    }
    cur.push(i);
    curTokens += c;
  });
  if (cur.length) units.push({ fid: f.fid, path: f.path, hunks: cur, tokens: curTokens });
  return units;
}

/**
 * Plans review chunks so each fits `budget` tokens of diff. Source files stay with their
 * tests, then files are grouped by top-level directory, then groups are bin-packed largest
 * first (first fit). A group over budget is packed unit by unit; a file over budget is split
 * by hunks. Noise, binary and content-free files are not sent and never appear here.
 */
export function planChunks(diff: DiffModel, budget: number): Chunk[] {
  const files = diff.files.filter((f) => f.noise === null && !f.binary && f.hunks.length > 0);
  const sourceGroup = new Map<string, string>();
  for (const f of files) if (!isTestPath(f.path)) sourceGroup.set(stem(f.path), topDir(f.path));

  const groups = new Map<string, Unit[]>();
  for (const f of files) {
    const key = (isTestPath(f.path) ? sourceGroup.get(stem(f.path)) : undefined) ?? topDir(f.path);
    groups.set(key, [...(groups.get(key) ?? []), ...unitsOf(f, budget)]);
  }

  const bins: { units: Unit[]; tokens: number }[] = [];
  const place = (units: Unit[], tokens: number): void => {
    const bin = bins.find((b) => b.tokens + tokens <= budget);
    if (bin) {
      bin.units.push(...units);
      bin.tokens += tokens;
    } else bins.push({ units: [...units], tokens });
  };
  const sum = (us: Unit[]): number => us.reduce((n, u) => n + u.tokens, 0);
  const sorted = [...groups.entries()].sort(
    ([ka, a], [kb, b]) => sum(b) - sum(a) || (ka < kb ? -1 : 1),
  );
  for (const [, units] of sorted) {
    if (sum(units) <= budget) place(units, sum(units));
    // Unit by unit in diff order, so a split file's hunks stay in sequence across chunks.
    else for (const u of units) place([u], u.tokens);
  }

  return bins.map((b) => ({ items: mergeItems(b.units), tokens: Math.ceil(b.tokens) }));
}

/** Hunk units of the same file that landed in the same chunk become one item, in path order. */
function mergeItems(units: Unit[]): ChunkItem[] {
  const byFid = new Map<string, Unit[]>();
  for (const u of units) byFid.set(u.fid, [...(byFid.get(u.fid) ?? []), u]);
  return [...byFid.values()]
    .sort((a, b) => ((a[0]?.path ?? '') < (b[0]?.path ?? '') ? -1 : 1))
    .map((us) => {
      const fid = us[0]?.fid ?? '';
      if (us.some((u) => u.hunks === null)) return { fid, hunks: null };
      return { fid, hunks: us.flatMap((u) => u.hunks ?? []).sort((a, b) => a - b) };
    });
}
