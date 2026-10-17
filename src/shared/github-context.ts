/** Read-only review context fetched from GitHub for an open pull request. */
export interface GitHubReview {
  author: string;
  state: string;
  submittedAt: string | null;
  body: string;
  url: string | null;
}

export interface GitHubReviewThread {
  path: string | null;
  line: number | null;
  outdated: boolean;
  author: string;
  body: string;
  createdAt: string | null;
  url: string | null;
}

export interface GitHubCheck {
  name: string;
  /** GitHub check-run status or commit-status state. */
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
}

/** A person or team GitHub has asked to review this pull request. */
export interface GitHubRequestedReviewer {
  kind: 'user' | 'team';
  /** `login` for a user, or `org/slug` for a team. */
  handle: string;
}

/** The last CODEOWNERS rule that applies to one or more changed files. */
export interface GitHubOwnershipRule {
  pattern: string;
  owners: string[];
  paths: string[];
}

export interface GitHubOwnership {
  /** The CODEOWNERS file from the PR base branch, if one exists. */
  sourcePath: string | null;
  /** Effective ownership rules for changed files; GitHub uses the last matching rule. */
  rules: GitHubOwnershipRule[];
  /** Changed paths that have no matching CODEOWNERS rule. */
  unownedPaths: string[];
}

export interface GitHubContext {
  /** Submitted approvals, requested changes and comments, newest first. */
  reviews: GitHubReview[];
  requestedReviewers: GitHubRequestedReviewer[];
  ownership: GitHubOwnership;
  /** Only unresolved review threads. */
  unresolvedThreads: GitHubReviewThread[];
  checks: GitHubCheck[];
  /** GitHub paginates these connections; true means the visible result is capped at 100. */
  truncated: boolean;
}
