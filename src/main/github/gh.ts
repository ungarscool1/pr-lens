import { z } from 'zod';
import { AppError } from '../../shared/errors';
import type { BinHealth, Health } from '../../shared/health';
import type { LinkedIssue, PrMeta, PrRef } from '../../shared/pr';
import type { Inbox, InboxOrganization, InboxPullRequest, InboxReviewRequest } from '../../shared/inbox';
import type { CompareCommit, RefSuggestion, RepoRef } from '../../shared/subject';
import type { Exec } from '../exec/exec';
import { ghEnv, requireBin } from '../exec/toolchain';
import type { ToolchainService } from '../exec/toolchain';

export interface GitHubClient {
  health(): Promise<Health['gh']>;
  prMeta(ref: PrRef): Promise<PrMeta>;
  /** Unified diff, three-dot (merge-base), exactly what GitHub shows. */
  prDiff(ref: PrRef): Promise<string>;
  /** Branch, tag or SHA → full commit SHA. */
  resolveCommit(repo: RepoRef, ref: string): Promise<string>;
  compare(repo: RepoRef, baseSha: string, headSha: string): Promise<CompareInfo>;
  /** Three-dot unified diff of a compare range (GitHub's API has no two-dot diff). */
  compareDiff(repo: RepoRef, baseSha: string, headSha: string): Promise<string>;
  tagsAmong(repo: RepoRef, names: string[]): Promise<Set<string>>;
  searchRefs(
    repo: RepoRef,
    query: string,
  ): Promise<{ defaultBranch: string | null; refs: RefSuggestion[] }>;
  /** Open PRs authored by the viewer and review requests addressed to them or their teams. */
  inbox(): Promise<Inbox>;
}

export interface CompareInfo {
  mergeBaseSha: string;
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  commits: CompareCommit[];
  url: string;
}

// Constant jq filter: the compare JSON carries every file patch; keep only what we use.
const COMPARE_JQ =
  '{merge_base: .merge_base_commit.sha, ahead: .ahead_by, behind: .behind_by, total: .total_commits, url: .html_url, commits: [.commits[] | {sha, subject: (.commit.message | split("\\n")[0]), author: (.author.login // .commit.author.name // "")}]}';

const CompareJson = z.object({
  merge_base: z.string(),
  ahead: z.number(),
  behind: z.number(),
  total: z.number(),
  url: z.string(),
  commits: z.array(z.object({ sha: z.string(), subject: z.string(), author: z.string() })),
});

const REFS_QUERY = `query($owner: String!, $name: String!, $q: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    heads: refs(refPrefix: "refs/heads/", query: $q, first: 15) { nodes { name } }
    tags: refs(refPrefix: "refs/tags/", query: $q, first: 15, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { nodes { name } }
  }
}`;

const RefsJson = z.object({
  data: z.object({
    repository: z.object({
      defaultBranchRef: z.object({ name: z.string() }).nullable(),
      heads: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
      tags: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
    }),
  }),
});

const TAG_QUERY = `query($owner: String!, $name: String!, $a: String!, $b: String!) {
  repository(owner: $owner, name: $name) { a: ref(qualifiedName: $a) { name } b: ref(qualifiedName: $b) { name } }
}`;

const TagJson = z.object({
  data: z.object({
    repository: z.object({
      a: z.object({ name: z.string() }).nullable(),
      b: z.object({ name: z.string() }).nullable(),
    }),
  }),
});

const InboxSearchJson = z.object({
  items: z.array(
    z.object({
      number: z.number(),
      title: z.string(),
      html_url: z.string().url(),
      updated_at: z.string(),
      user: z.object({ login: z.string() }).nullable(),
      // Search returns this stable API URL rather than an embedded repository object.
      repository_url: z.string().url(),
    }),
  ),
});

const OrgListJson = z.array(
  z.object({
    login: z.string(),
    name: z.string().nullable().optional(),
    // GET /user/orgs returns an API url; html_url is not guaranteed on this endpoint.
    html_url: z.string().url().optional(),
  }),
);

const asInboxPr = (pr: z.infer<typeof InboxSearchJson>['items'][number]): InboxPullRequest => {
  const match = /\/repos\/([^/]+)\/([^/]+)$/.exec(pr.repository_url);
  const owner = match?.[1];
  const repo = match?.[2];
  if (!owner || !repo) throw new AppError('INTERNAL', 'GitHub returned an invalid repository URL.');
  return {
    owner: decodeURIComponent(owner),
    repo: decodeURIComponent(repo),
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    author: pr.user?.login ?? 'ghost',
    updatedAt: pr.updated_at,
    // Search deliberately avoids per-row protected-org lookups. The detail view loads this.
    reviewDecision: null,
    reviewRequestCount: 0,
  };
};

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
  /** An inaccessible organization must not make the whole home screen unavailable. */
  const optionalGh = async (args: string[]): Promise<string | null> => {
    try {
      return await gh(args);
    } catch {
      return null;
    }
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

    async resolveCommit(repo, ref) {
      try {
        const sha = (
          await gh(['api', `repos/${repo.owner}/${repo.repo}/commits/${ref}`, '--jq', '.sha'])
        ).trim();
        if (!/^[0-9a-f]{40}$/.test(sha)) throw new AppError('NOT_FOUND');
        return sha;
      } catch (err) {
        const e = AppError.from(err);
        // gh says "No commit found for SHA" (HTTP 422) for any unknown branch, tag or SHA.
        if (
          e.code === 'NOT_FOUND' ||
          (e.code === 'EXEC_FAILED' && /422|No commit found/i.test(e.message))
        ) {
          throw new AppError(
            'NOT_FOUND',
            `"${ref}" is not a branch, tag or commit in ${repo.owner}/${repo.repo}.`,
          );
        }
        throw e;
      }
    },

    async compare(repo, baseSha, headSha) {
      const out = await gh([
        'api',
        `repos/${repo.owner}/${repo.repo}/compare/${baseSha}...${headSha}`,
        '--jq',
        COMPARE_JQ,
      ]);
      const c = CompareJson.parse(JSON.parse(out));
      return {
        mergeBaseSha: c.merge_base,
        aheadBy: c.ahead,
        behindBy: c.behind,
        totalCommits: c.total,
        commits: c.commits,
        url: c.url,
      };
    },

    compareDiff: (repo, baseSha, headSha) =>
      gh(
        [
          'api',
          '-H',
          'Accept: application/vnd.github.diff',
          `repos/${repo.owner}/${repo.repo}/compare/${baseSha}...${headSha}`,
        ],
        120_000,
      ),

    async tagsAmong(repo, names) {
      const [a = '', b = a] = names;
      const out = await gh([
        'api',
        'graphql',
        '-f',
        `query=${TAG_QUERY}`,
        '-f',
        `owner=${repo.owner}`,
        '-f',
        `name=${repo.repo}`,
        '-f',
        `a=refs/tags/${a}`,
        '-f',
        `b=refs/tags/${b}`,
      ]);
      const r = TagJson.parse(JSON.parse(out)).data.repository;
      return new Set([r.a?.name, r.b?.name].filter((n): n is string => !!n));
    },

    async searchRefs(repo, query) {
      // -f (not -F): values stay strings, so a repo named "123" is not sent as a number.
      const out = await gh([
        'api',
        'graphql',
        '-f',
        `query=${REFS_QUERY}`,
        '-f',
        `owner=${repo.owner}`,
        '-f',
        `name=${repo.repo}`,
        '-f',
        `q=${query}`,
      ]);
      const r = RefsJson.parse(JSON.parse(out)).data.repository;
      return {
        defaultBranch: r.defaultBranchRef?.name ?? null,
        refs: [
          ...r.heads.nodes.map((n) => ({ name: n.name, kind: 'branch' as const })),
          ...r.tags.nodes.map((n) => ({ name: n.name, kind: 'tag' as const })),
        ],
      };
    },

    async inbox() {
      // Search never fans out into protected repositories. Each source is independent, so a
      // SAML-gated organization leaves the rest of the Inbox usable.
      const [viewer, orgsOut, authoredOut, requestedOut] = await Promise.all([
        gh(['api', 'user', '--jq', '.login']),
        optionalGh(['api', 'user/orgs?per_page=100']),
        optionalGh([
          'api',
          '-X',
          'GET',
          'search/issues',
          '-f',
          'q=is:pr is:open author:@me',
          '-f',
          'sort=updated',
          '-f',
          'order=desc',
          '-F',
          'per_page=50',
        ]),
        optionalGh([
          'api',
          '-X',
          'GET',
          'search/issues',
          '-f',
          'q=is:pr is:open review-requested:@me',
          '-f',
          'sort=updated',
          '-f',
          'order=desc',
          '-F',
          'per_page=50',
        ]),
      ]);
      // A successful gh command can still have a shape GitHub changes or omits. Treat every
      // optional source as unavailable in that case rather than letting Zod take down Inbox.
      const orgs = orgsOut ? OrgListJson.safeParse(safeJson(orgsOut)) : null;
      const authoredSearch = authoredOut ? InboxSearchJson.safeParse(safeJson(authoredOut)) : null;
      const requestedSearch = requestedOut
        ? InboxSearchJson.safeParse(safeJson(requestedOut))
        : null;
      const unavailable: Inbox['unavailable'] = [];
      if (!orgs?.success) unavailable.push('organizations');
      if (!authoredSearch?.success) unavailable.push('authored');
      if (!requestedSearch?.success) unavailable.push('requested');
      const organizations: InboxOrganization[] = orgs?.success
        ? orgs.data.map((org) => ({
            login: org.login,
            name: org.name ?? org.login,
            url: org.html_url ?? `https://github.com/${encodeURIComponent(org.login)}`,
          }))
        : [];
      const authored = authoredSearch?.success
        ? authoredSearch.data.items.map(asInboxPr)
        : [];
      const requested: InboxReviewRequest[] = requestedSearch?.success
        ? requestedSearch.data.items.map((pr) => ({
            ...asInboxPr(pr),
            requestedAs: 'you or a team you belong to',
          }))
        : [];
      return {
        viewer: viewer.trim(),
        organizations,
        authored,
        requested: requested.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        unavailable,
      };
    },
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
