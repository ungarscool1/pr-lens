import { describe, expect, it } from 'vitest';
import { changedRanges, markRange, tokenize } from './highlight';

describe('tokenize', () => {
  it('classifies keywords, calls, types, strings and comments', () => {
    const toks = tokenize('const s = new Map<string, Session>(); // cache');
    const kinds = Object.fromEntries(toks.filter((t) => t.s.trim()).map((t) => [t.s.trim(), t.k]));
    expect(kinds).toMatchObject({
      const: 'kw',
      new: 'kw',
      Map: 'type',
      Session: 'type',
      '// cache': 'com',
    });
    expect(tokenize('x = "a \\" b"').find((t) => t.k === 'str')?.s).toBe('"a \\" b"');
  });

  it('round-trips the text', () => {
    const line = '  if (!session) return null;';
    expect(
      tokenize(line)
        .map((t) => t.s)
        .join(''),
    ).toBe(line);
  });
});

describe('changedRanges / markRange', () => {
  it('finds the changed word span', () => {
    const del = 'Promise<Session> {';
    const add = 'Promise<Session | null> {';
    expect(changedRanges(del, add)).toEqual({ del: [15, 15], add: [15, 22] });
  });

  it('returns null for unrelated lines', () => {
    expect(changedRanges('abc', 'xyz')).toBeNull();
  });

  it('splits tokens on the range and keeps the text', () => {
    const toks = markRange(tokenize('return value;'), [7, 12]);
    expect(toks.map((t) => t.s).join('')).toBe('return value;');
    expect(
      toks
        .filter((t) => t.changed)
        .map((t) => t.s)
        .join(''),
    ).toBe('value');
  });
});
