import { describe, expect, it } from 'vitest';
import { parseRepo } from '../../../../shared/subject';
import { diffLabel } from './compareLabel';

describe('parseRepo', () => {
  it.each([
    ['cli/cli', { owner: 'cli', repo: 'cli' }],
    ['https://github.com/acme/api.git', { owner: 'acme', repo: 'api' }],
    ['github.com/acme/my.repo/', { owner: 'acme', repo: 'my.repo' }],
  ])('%s', (s, r) => expect(parseRepo(s)).toEqual(r));
  it.each(['acme', 'acme/api/pull/1', '-x/y', 'a b/c'])('rejects %s', (s) =>
    expect(parseRepo(s)).toBeNull(),
  );
});

describe('diffLabel', () => {
  const m = { mergeBaseSha: '44ee1776aaaa', head: 'v2.61.0' };
  it('names the merge base for three-dot', () => {
    expect(diffLabel({ ...m, mode: 'three-dot', behindBy: 0 })).toBe(
      'Showing changes on v2.61.0 since the merge base 44ee177 · same as GitHub',
    );
  });
  it('says when a direct diff equals the merge-base one, and when it does not', () => {
    expect(diffLabel({ ...m, mode: 'two-dot', behindBy: 0 })).toContain('same as merge base here');
    expect(diffLabel({ ...m, mode: 'two-dot', behindBy: 3 })).toContain('includes changes on base');
  });
});
