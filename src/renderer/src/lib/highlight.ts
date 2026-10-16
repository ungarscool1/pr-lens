/** A small, language-agnostic highlighter and intra-line diff, ported from the design. */

export type TokKind = 'kw' | 'type' | 'str' | 'num' | 'com' | 'fn' | 'plain';

export interface Tok {
  s: string;
  k: TokKind;
  /** Part of the changed span inside a modified line. */
  changed?: boolean;
}

const KW = new Set(
  'import from export async function const let var return if else for while await throw new type interface null undefined true false of as in class extends def fn func pub use package struct'.split(
    ' ',
  ),
);

const TOKEN_RE =
  /(\/\/.*$|#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)|(\s+|.)/g;

export function tokenize(line: string): Tok[] {
  if (/^\s*(\/\/|\/\*|\*\/|\* |\*$)/.test(line)) return [{ s: line, k: 'com' }];
  const out: Tok[] = [];
  const push = (s: string, k: TokKind): void => {
    const last = out[out.length - 1];
    if (last && last.k === k) last.s += s;
    else out.push({ s, k });
  };
  for (const m of line.matchAll(TOKEN_RE)) {
    if (m[1]) push(m[1], 'com');
    else if (m[2]) push(m[2], 'str');
    else if (m[3]) push(m[3], 'num');
    else if (m[4]) push(m[4], KW.has(m[4]) ? 'kw' : 'fn');
    else if (m[5]) push(m[5], KW.has(m[5]) ? 'kw' : /^[A-Z]/.test(m[5]) ? 'type' : 'plain');
    else push(m[6] ?? '', 'plain');
  }
  return out;
}

/**
 * Common prefix/suffix between a removed and an added line, widened to word boundaries.
 * Returns the changed [start, end) range in each, or null when the lines share nothing.
 */
export function changedRanges(
  del: string,
  add: string,
): { del: [number, number]; add: [number, number] } | null {
  let p = 0;
  while (p < del.length && p < add.length && del[p] === add[p]) p++;
  let q = 0;
  while (
    q < del.length - p &&
    q < add.length - p &&
    del[del.length - 1 - q] === add[add.length - 1 - q]
  )
    q++;
  if (p === 0 && q === 0) return null;
  while (p > 0 && /\w/.test(del[p - 1] ?? '') && /\w/.test(del[p] ?? '')) p--;
  return { del: [p, del.length - q], add: [p, add.length - q] };
}

/** Splits tokens so the characters in `range` are marked `changed`. */
export function markRange(toks: readonly Tok[], range: [number, number]): Tok[] {
  const [from, to] = range;
  if (from >= to) return [...toks];
  const out: Tok[] = [];
  let pos = 0;
  for (const t of toks) {
    const a = pos;
    const b = pos + t.s.length;
    pos = b;
    const cuts = [a, Math.max(a, Math.min(b, from)), Math.max(a, Math.min(b, to)), b];
    for (let i = 0; i < 3; i++) {
      const x = cuts[i] ?? a;
      const y = cuts[i + 1] ?? b;
      if (y > x)
        out.push({ s: t.s.slice(x - a, y - a), k: t.k, ...(i === 1 ? { changed: true } : {}) });
    }
  }
  return out;
}
