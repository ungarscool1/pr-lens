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
 * mutate. Everything here creates, extends, or edits the viewer's PENDING review, which nobody
 * else sees until they submit it on GitHub.
 */
export interface GitHubWriteClient {
  reviewContext(ref: PrRef): Promise<ReviewContext>;
  /** Starts a pending review on `headSha` (no event = PENDING). */
  createPendingReview(prId: string, headSha: string): Promise<string>;
  addThread(
    reviewId: string,
    thread: ThreadInput,
  ): Promise<{ url: string | null; commentId: string | null }>;
  /** A review comment's state, author and PR, as seen by the gh viewer; null if not a review comment. */
  pendingComment(commentId: string): Promise<CommentInfo | null>;
  /** Replaces a review comment's body. Callers check it is the viewer's PENDING comment first. */
  updateComment(commentId: string, body: string): Promise<void>;
  /** Publishes the viewer's pending review, including every thread already staged in it. */
  submitReview(
    reviewId: string,
    event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES',
    body: string,
  ): Promise<{ url: string | null; state: string }>;
}

export interface ReviewContext {
  prId: string;
  headSha: string;
  viewer: string;
  /** The viewer's own pending review on this PR, if any. */
  pendingReviewId: string | null;
}

export interface CommentInfo {
  /** `PENDING` until the review that holds it is submitted. */
  state: string;
  author: string | null;
  viewer: string;
  viewerCanUpdate: boolean;
  owner: string;
  repo: string;
  number: number;
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
    thread { id comments(first: 1) { nodes { id url } } }
  }
}`;

const ADD_FILE_THREAD = `mutation($review: ID!, $path: String!, $body: String!) {
  addPullRequestReviewThread(input: { pullRequestReviewId: $review, path: $path, body: $body, subjectType: FILE }) {
    thread { id comments(first: 1) { nodes { id url } } }
  }
}`;

const ThreadJson = z.object({
  data: z.object({
    addPullRequestReviewThread: z.object({
      thread: z
        .object({
          comments: z.object({
            nodes: z.array(z.object({ id: z.string().optional(), url: z.string() })),
          }),
        })
        .nullable(),
    }),
  }),
});

const PENDING_COMMENT = `query($comment: ID!) {
  viewer { login }
  node(id: $comment) {
    ... on PullRequestReviewComment {
      state
      author { login }
      viewerCanUpdate
      pullRequest { number repository { owner { login } name } }
    }
  }
}`;

const CommentJson = z.object({
  data: z.object({
    viewer: z.object({ login: z.string() }),
    // Any other node type matches no fragment and comes back as `{}`.
    node: z
      .object({
        state: z.string().optional(),
        author: z.object({ login: z.string() }).nullable().optional(),
        viewerCanUpdate: z.boolean().optional(),
        pullRequest: z
          .object({
            number: z.number().int(),
            repository: z.object({ owner: z.object({ login: z.string() }), name: z.string() }),
          })
          .optional(),
      })
      .nullable(),
  }),
});

const UPDATE_COMMENT = `mutation($comment: ID!, $body: String!) {
  updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $comment, body: $body }) {
    pullRequestReviewComment { id }
  }
}`;

const UpdateJson = z.object({
  data: z.object({
    updatePullRequestReviewComment: z.object({
      pullRequestReviewComment: z.object({ id: z.string() }),
    }),
  }),
});

const SUBMIT_REVIEW = `mutation($review: ID!, $event: PullRequestReviewEvent!, $body: String!) {
  submitPullRequestReview(input: { pullRequestReviewId: $review, event: $event, body: $body }) {
    pullRequestReview { state url }
  }
}`;

const SubmitJson = z.object({
  data: z.object({
    submitPullRequestReview: z.object({
      pullRequestReview: z.object({ url: z.string().nullable(), state: z.string() }),
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
  if (/could not resolve to a node/i.test(stderr)) {
    return new AppError('NOT_FOUND', 'GitHub no longer has that comment.');
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
      const first = ThreadJson.parse(raw).data.addPullRequestReviewThread.thread?.comments.nodes[0];
      return { url: first?.url ?? null, commentId: first?.id ?? null };
    },

    async pendingComment(commentId) {
      const d = CommentJson.parse(await graphql(PENDING_COMMENT, { comment: commentId })).data;
      const n = d.node;
      if (!n?.state || !n.pullRequest) return null;
      return {
        state: n.state,
        author: n.author?.login ?? null,
        viewer: d.viewer.login,
        viewerCanUpdate: n.viewerCanUpdate ?? false,
        owner: n.pullRequest.repository.owner.login,
        repo: n.pullRequest.repository.name,
        number: n.pullRequest.number,
      };
    },

    async updateComment(commentId, body) {
      UpdateJson.parse(await graphql(UPDATE_COMMENT, { comment: commentId, body }));
    },

    async submitReview(reviewId, event, body) {
      const review = SubmitJson.parse(await graphql(SUBMIT_REVIEW, { review: reviewId, event, body }))
        .data.submitPullRequestReview.pullRequestReview;
      return review;
    },
  };
}
