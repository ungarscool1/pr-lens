import { z } from 'zod';
import { AppError } from '../../shared/errors';
import type { BinHealth, Health } from '../../shared/health';
import type { LinkedIssue, PrMeta, PrRef } from '../../shared/pr';
import type { Exec } from '../exec/exec';
import { ghEnv, requireBin } from '../exec/toolchain';
import type { ToolchainService } from '../exec/toolchain';

export interface GitHubClient {
  health(): Promise<Health['gh']>;
  prMeta(ref: PrRef): Promise<PrMeta>;
  /** Unified diff, three-dot (merge-base), exactly what GitHub shows. */
  prDiff(ref: PrRef): Promise<string>;
}

const MAX_LINKED_ISSUES = 3;
const ISSUE_BODY_LIMIT = 2_000;

const PrViewJson = z.object({
  url: z.string(),
  title: z.string(),
  body: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  author: z.object({ login: z.string() }),
  baseRefName: z.string(),
  headRefName: z.string(),
  baseRefOid: z.string(),
  headRefOid: z.string(),
  commits: z.array(z.unknown()),
  closingIssuesReferences: z.array(
    z.object({
      number: z.number(),
      repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
    }),
  ),
});

const IssueJson = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
});

const AuthStatusJson = z.object({
  hosts: z.record(
    z.string(),
    z.array(
      z.object({
        state: z.string(),
        active: z.boolean(),
        login: z.string(),
        scopes: z.string().optional(),
      }),
    ),
  ),
});

/** Maps gh's stderr to a typed error. Only the classification leaves this function, not the text. */
export function classifyGhError(stderr: string): AppError {
  const s = stderr.toLowerCase();
  if (/gh auth login|not logged in|authentication required|bad credentials|http 401/.test(s)) {
    return new AppError('GH_NOT_AUTHENTICATED');
  }
  if (/rate limit|http 403: api rate|secondary rate/.test(s)) return new AppError('RATE_LIMITED');
  if (/diff exceeded|too large|http 406|maximum number of (lines|files)/.test(s)) {
    return new AppError('DIFF_TOO_LARGE');
  }
  if (/could not resolve to a|not found|http 404/.test(s)) return new AppError('NOT_FOUND');
  const firstLine = stderr.trim().split('\n')[0]?.slice(0, 200) ?? '';
  return new AppError('EXEC_FAILED', firstLine ? `gh failed: ${firstLine}` : 'gh failed.');
}

export function createGhClient(exec: Exec, toolchain: ToolchainService): GitHubClient {
  const gh = async (args: string[], timeoutMs = 60_000): Promise<string> => {
    const tc = await toolchain.get();
    const res = await exec({ file: requireBin(tc.gh, 'gh'), args, env: ghEnv(tc), timeoutMs });
    if (res.code !== 0) throw classifyGhError(res.stderr);
    return res.stdout;
  };
  const repoFlag = (r: { owner: string; repo: string }): string => `--repo=${r.owner}/${r.repo}`;

  const linkedIssue = async (
    owner: string,
    repo: string,
    n: number,
  ): Promise<LinkedIssue | null> => {
    try {
      const out = await gh([
        'issue',
        'view',
        String(n),
        repoFlag({ owner, repo }),
        '--json',
        'number,title,body,url',
      ]);
      const issue = IssueJson.parse(JSON.parse(out));
      return { ...issue, body: issue.body.slice(0, ISSUE_BODY_LIMIT) };
    } catch {
      // A linked issue in a repo we cannot read is not worth failing the whole PR load.
      return null;
    }
  };

  return {
    async health() {
      const tc = await toolchain.get();
      const base: BinHealth = { path: tc.gh, version: null, problem: null };
      const none = { authenticated: false, user: null, scopes: [] };
      if (!tc.gh)
        return { ...base, ...none, problem: 'gh not found. Install it with `brew install gh`.' };
      const env = ghEnv(tc);
      const [ver, auth] = await Promise.all([
        exec({ file: tc.gh, args: ['--version'], env, timeoutMs: 10_000 }),
        exec({
          file: tc.gh,
          args: ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'],
          env,
          timeoutMs: 15_000,
        }),
      ]);
      const version = /gh version (\S+)/.exec(ver.stdout)?.[1] ?? null;
      const parsed = AuthStatusJson.safeParse(safeJson(auth.stdout));
      const host = parsed.success
        ? parsed.data.hosts['github.com']?.find((h) => h.active)
        : undefined;
      if (!host || host.state !== 'success') {
        return { ...base, version, ...none, problem: 'gh is not logged in. Run `gh auth login`.' };
      }
      const scopes = (host.scopes ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return { ...base, version, authenticated: true, user: host.login, scopes };
    },

    async prMeta(ref) {
      const fields =
        'url,title,body,state,isDraft,author,baseRefName,headRefName,baseRefOid,headRefOid,commits,closingIssuesReferences';
      const out = await gh(['pr', 'view', String(ref.number), repoFlag(ref), '--json', fields]);
      const pr = PrViewJson.parse(JSON.parse(out));
      const issues = await Promise.all(
        pr.closingIssuesReferences
          .slice(0, MAX_LINKED_ISSUES)
          .map((i) => linkedIssue(i.repository.owner.login, i.repository.name, i.number)),
      );
      return {
        url: pr.url,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        isDraft: pr.isDraft,
        author: pr.author.login,
        baseRefName: pr.baseRefName,
        headRefName: pr.headRefName,
        baseSha: pr.baseRefOid,
        headSha: pr.headRefOid,
        commitCount: pr.commits.length,
        linkedIssues: issues.filter((i): i is LinkedIssue => i !== null),
      };
    },

    prDiff: (ref) =>
      gh(['pr', 'diff', String(ref.number), repoFlag(ref), '--color=never'], 120_000),
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
