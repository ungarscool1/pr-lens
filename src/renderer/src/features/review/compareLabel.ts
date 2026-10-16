import type { CompareMeta } from '../../../../shared/subject';

export const short = (sha: string): string => sha.slice(0, 7);

/** Says exactly which diff is on screen, since the two modes can differ a lot. */
export function diffLabel(
  m: Pick<CompareMeta, 'mode' | 'mergeBaseSha' | 'behindBy' | 'head'>,
): string {
  if (m.mode === 'three-dot') {
    return `Showing changes on ${m.head} since the merge base ${short(m.mergeBaseSha)} · same as GitHub`;
  }
  return m.behindBy === 0
    ? 'Showing base to head directly · same as merge base here, base is an ancestor of head'
    : 'Showing base tree to head tree directly · includes changes on base that head does not have';
}
