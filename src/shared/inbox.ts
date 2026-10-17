export interface InboxPullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  updatedAt: string;
  /** GitHub's current aggregate decision, or null while no decision exists. */
  reviewDecision: string | null;
  reviewRequestCount: number;
}

export interface InboxReviewRequest extends InboxPullRequest {
  /** GitHub matched the request to the viewer directly or through one of their teams. */
  requestedAs: string;
}

export interface InboxOrganization {
  login: string;
  name: string;
  url: string;
}

export interface Inbox {
  viewer: string;
  organizations: InboxOrganization[];
  authored: InboxPullRequest[];
  requested: InboxReviewRequest[];
  /** Sources GitHub refused, e.g. an organization awaiting SAML authorization. */
  unavailable: ('organizations' | 'authored' | 'requested')[];
}
