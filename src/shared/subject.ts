import { z } from 'zod';
import { formatPrRef, PrRef } from './pr';

/** How a compare range is diffed. */
export const DiffMode = z.enum(['three-dot', 'two-dot']);
export type DiffMode = z.infer<typeof DiffMode>;

export const DIFF_MODE_LABELS: Record<DiffMode, string> = {
  'three-dot': 'Merge base (three-dot)',
  'two-dot': 'Direct (two-dot)',
};

export const Sha = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * A branch, tag or SHA as typed by the user. Tighter than git's own rules on purpose: it goes
 * into GitHub API paths, so no "..", "@{", leading "-", control characters or spaces.
 */
export const GitRefName = z
  .string()
  .trim()
  .min(1)
  .max(250)
  .regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/+@-]+$/)
  .refine(
    (r) => !r.endsWith('/') && !r.endsWith('.') && !r.endsWith('.lock'),
    'Not a valid ref name',
  );

export const RepoRef = PrRef.pick({ owner: true, repo: true });
export type RepoRef = z.infer<typeof RepoRef>;

/** What a review is about: a pull request, or a compare range pinned to SHAs. */
export const Subject = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pr'), ref: PrRef }).strict(),
  RepoRef.extend({
    kind: z.literal('compare'),
    baseSha: Sha,
    headSha: Sha,
    mode: DiffMode,
  }).strict(),
]);
export type Subject = z.infer<typeof Subject>;

export const repoOf = (s: Subject): RepoRef =>
  s.kind === 'pr' ? { owner: s.ref.owner, repo: s.ref.repo } : { owner: s.owner, repo: s.repo };

/** File-name-safe and stable: notes and cached analyses are stored under it. */
export function subjectSlug(s: Subject): string {
  if (s.kind === 'pr') return `${s.ref.owner}__${s.ref.repo}__${s.ref.number}`;
  const dots = s.mode === 'three-dot' ? '3dot' : '2dot';
  return `${s.owner}__${s.repo}__compare__${dots}__${s.baseSha.slice(0, 12)}__${s.headSha.slice(0, 12)}`;
}

/** `acme/api#812@<head>` or `acme/api@<base>...<head>` / `..` for two-dot. */
export function targetKeyOf(s: Subject, headSha: string): string {
  if (s.kind === 'pr') return `${formatPrRef(s.ref)}@${headSha}`;
  return `${s.owner}/${s.repo}@${s.baseSha}${s.mode === 'three-dot' ? '...' : '..'}${s.headSha}`;
}

export const TargetKey = z
  .string()
  .max(400)
  .regex(/^[^/\s]+\/[^/\s#@]+(#\d+@[0-9a-f]{7,64}|@[0-9a-f]{40}\.{2,3}[0-9a-f]{40})$/);

/** One review target: a subject at a head SHA. */
export interface Target {
  key: string;
  subject: Subject;
  headSha: string;
}

export interface CompareCommit {
  sha: string;
  subject: string;
  author: string;
}

export interface CompareMeta {
  owner: string;
  repo: string;
  /** As typed: branch, tag or SHA. */
  base: string;
  head: string;
  mode: DiffMode;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  /** At most 250 (GitHub's limit), oldest first. */
  commits: CompareCommit[];
  baseIsTag: boolean;
  headIsTag: boolean;
  url: string;
}

export interface RefSuggestion {
  name: string;
  kind: 'branch' | 'tag';
}

/** `owner/repo` or a github.com URL to the repo. */
export function parseRepo(input: string): RepoRef | null {
  const m =
    /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(
      input.trim(),
    );
  const r = m ? RepoRef.safeParse({ owner: m[1], repo: m[2] }) : null;
  return r?.success ? r.data : null;
}
