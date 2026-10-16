import { z } from 'zod';
import { AppError } from '../../shared/errors';
import type { Side } from '../../shared/diff';
import type { PrRef } from '../../shared/pr';
import type { Exec } from '../exec/exec';
import { ghEnv, requireBin } from '../exec/toolchain';
import type { ToolchainService } from '../exec/toolchain';
import { classifyGhError } from '../github/gh';

/**
 * The only code that writes to GitHub. Imported by promote/ alone; the read client cannot
 * mutate. Everything here creates or extends the viewer's PENDING review, which nobody else
 * sees until they submit it on GitHub.
 */
export interface GitHubWriteClient {
  reviewContext(ref: PrRef): Promise<ReviewContext>;
  /** Starts a pending review on `headSha` (no event = PENDING). */
  createPendingReview(prId: string, headSha: string): Promise<string>;
  addThread(reviewId: string, thread: ThreadInput): Promise<{ url: string | null }>;
}

export interface ReviewContext {
  prId: string;
  headSha: string;
  viewer: string;
  /** The viewer's own pending review on this PR, if any. */
  pendingReviewId: string | null;
}

export type ThreadInput =
  | { kind: 'line'; path: string; side: Side; line: number; startLine?: number; body: string }
  | { kind: 'file'; path: string; body: string };

const CONTEXT_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      headRefOid
      reviews(states: PENDING, first: 20) { nodes { id author { login } } }
    }
  }
}`;

const ContextJson = z.object({
  data: z.object({
    viewer: z.object({ login: z.string() }),
    repository: z.object({
      pullRequest: z.object({
        id: z.string(),
        headRefOid: z.string(),
        reviews: z.object({
          nodes: z.array(
            z.object({ id: z.string(), author: z.object({ login: z.string() }).nullable() }),
          ),
        }),
      }),
    }),
  }),
});

const CREATE_REVIEW = `mutation($pr: ID!, $commit: GitObjectID!) {
  addPullRequestReview(input: { pullRequestId: $pr, commitOID: $commit }) { pullRequestReview { id state } }
}`;

const CreateJson = z.object({
  data: z.object({
    addPullRequestReview: z.object({
      pullRequestReview: z.object({ id: z.string(), state: z.string() }),
    }),
  }),
});

const ADD_LINE_THREAD = `mutation($review: ID!, $path: String!, $body: String!, $line: Int!, $side: DiffSide!, $startLine: Int, $startSide: DiffSide) {
  addPullRequestReviewThread(input: { pullRequestReviewId: $review, path: $path, body: $body, line: $line, side: $side, startLine: $startLine, startSide: $startSide, subjectType: LINE }) {
    thread { id comments(first: 1) { nodes { url } } }
  }
}`;

const ADD_FILE_THREAD = `mutation($review: ID!, $path: String!, $body: String!) {
  addPullRequestReviewThread(input: { pullRequestReviewId: $review, path: $path, body: $body, subjectType: FILE }) {
    thread { id comments(first: 1) { nodes { url } } }
  }
}`;

const ThreadJson = z.object({
  data: z.object({
    addPullRequestReviewThread: z.object({
      thread: z
        .object({ comments: z.object({ nodes: z.array(z.object({ url: z.string() })) }) })
        .nullable(),
    }),
  }),
});

/** Mutation failures specific to writing; anything else falls back to the read classifier. */
export function classifyWriteError(stderr: string): AppError {
  if (
    /required scopes|not been granted|resource not accessible|must have (push|write)/i.test(stderr)
  ) {
    return new AppError(
      'GH_NOT_AUTHENTICATED',
      'Your gh login cannot comment on this PR. Run `gh auth refresh -s repo`, or check your access to the repository.',
    );
  }
  if (/one pending review/i.test(stderr)) {
    return new AppError('BAD_INPUT', 'GitHub reports a pending review already exists. Try again.');
  }
  if (
    /line could not be resolved|pull_request_review_thread\.line|is not part of the diff/i.test(
      stderr,
    )
  ) {
    return new AppError(
      'BAD_INPUT',
      'GitHub refused that line: it is not part of the PR diff any more.',
    );
  }
  return classifyGhError(stderr);
}

export function createWriteClient(exec: Exec, toolchain: ToolchainService): GitHubWriteClient {
  /** `gh api graphql`; -f keeps values as strings, -F sends numbers as numbers. */
  const graphql = async (
    query: string,
    strings: Record<string, string>,
    ints: Record<string, number> = {},
  ): Promise<unknown> => {
    const tc = await toolchain.get();
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [k, v] of Object.entries(strings)) args.push('-f', `${k}=${v}`);
    for (const [k, v] of Object.entries(ints)) args.push('-F', `${k}=${Math.trunc(v)}`);
    const r = await exec({
      file: requireBin(tc.gh, 'gh'),
      args,
      env: ghEnv(tc),
      timeoutMs: 60_000,
    });
    if (r.code !== 0) throw classifyWriteError(r.stderr);
    return JSON.parse(r.stdout);
  };

  return {
    async reviewContext(ref) {
      const raw = await graphql(
        CONTEXT_QUERY,
        { owner: ref.owner, name: ref.repo },
        { number: ref.number },
      );
      const d = ContextJson.parse(raw).data;
      const pr = d.repository.pullRequest;
      const mine = pr.reviews.nodes.find((r) => r.author?.login === d.viewer.login);
      return {
        prId: pr.id,
        headSha: pr.headRefOid,
        viewer: d.viewer.login,
        pendingReviewId: mine?.id ?? null,
      };
    },

    async createPendingReview(prId, headSha) {
      const r = CreateJson.parse(await graphql(CREATE_REVIEW, { pr: prId, commit: headSha }));
      const review = r.data.addPullRequestReview.pullRequestReview;
      if (review.state !== 'PENDING') {
        // Never expected without an event, but a submitted review must not pass silently.
        throw new AppError(
          'INTERNAL',
          `GitHub created a ${review.state} review instead of a pending one.`,
        );
      }
      return review.id;
    },

    async addThread(reviewId, t) {
      const raw =
        t.kind === 'file'
          ? await graphql(ADD_FILE_THREAD, { review: reviewId, path: t.path, body: t.body })
          : await graphql(
              ADD_LINE_THREAD,
              {
                review: reviewId,
                path: t.path,
                body: t.body,
                side: t.side,
                ...(t.startLine !== undefined ? { startSide: t.side } : {}),
              },
              { line: t.line, ...(t.startLine !== undefined ? { startLine: t.startLine } : {}) },
            );
      const thread = ThreadJson.parse(raw).data.addPullRequestReviewThread.thread;
      return { url: thread?.comments.nodes[0]?.url ?? null };
    },
  };
}
