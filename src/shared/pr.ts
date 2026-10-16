import { z } from 'zod';

// GitHub's own rules, tight enough that a value can never be read as a CLI flag.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export const PrRef = z.object({
  owner: z.string().regex(OWNER),
  repo: z
    .string()
    .regex(REPO)
    .refine((r) => r !== '.' && r !== '..'),
  number: z.number().int().positive().max(1_000_000_000),
});
export type PrRef = z.infer<typeof PrRef>;

export const PrInput = z.string().trim().min(1).max(300);

/** Accepts `https://github.com/o/r/pull/12[/files…]`, `github.com/o/r/pull/12` or `o/r#12`. */
export function parsePrInput(input: string): PrRef | null {
  const s = input.trim();
  const url =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(
      s,
    );
  const short = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(s);
  const m = url ?? short;
  if (!m) return null;
  const parsed = PrRef.safeParse({ owner: m[1], repo: m[2], number: Number(m[3]) });
  return parsed.success ? parsed.data : null;
}

export const formatPrRef = (r: PrRef): string => `${r.owner}/${r.repo}#${r.number}`;

export interface LinkedIssue {
  number: number;
  title: string;
  body: string;
  url: string;
}

export interface PrMeta {
  url: string;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  author: string;
  baseRefName: string;
  headRefName: string;
  baseSha: string;
  headSha: string;
  commitCount: number;
  linkedIssues: LinkedIssue[];
}

/** One PR at one head SHA. The key is what review jobs and caches refer to. */
export interface Target {
  key: string;
  ref: PrRef;
  headSha: string;
}

export const targetKey = (ref: PrRef, headSha: string): string => `${formatPrRef(ref)}@${headSha}`;

export const TargetKey = z
  .string()
  .max(400)
  .regex(/^[^/\s]+\/[^/\s#]+#\d+@[0-9a-f]{7,64}$/);
