import type {
  DraftFollowUpInput,
  PullRequestReviewInput,
  SubjectType,
} from "@kotx/shared";

export interface NormalizedSubject {
  type: SubjectType;
  number: number;
  state: "open" | "closed";
  assignees: string[];
  requestedReviewers: string[];
  title: string;
  body: string;
  // The subject's author login (PR author, or issue opener). Used as the
  // fallback owner when a PR has no explicit GitHub assignee (see subjectOwners).
  author?: string;
  headRef?: string;
  headRepoFullName?: string;
  baseRef?: string;
  merged?: boolean;
}

export interface Normalized {
  event: string;
  action: string;
  repoFullName: string;
  defaultBranch?: string;
  senderLogin: string;
  subject: NormalizedSubject | null;
  // who was just assigned / requested for review in this action (assigned,
  // review_requested) — lets us check it's me without re-listing.
  targetLogin?: string;
  comment?: DraftFollowUpInput;
  pullRequestReview?: PullRequestReviewInput;
  // push events: the fully-qualified ref that was pushed (refs/heads/<branch>).
  pushRef?: string;
}

/**
 * The subject's "owners": its explicit GitHub assignees, or — when a PR has no
 * assignee — the PR author as a fallback. Empty when neither is known. This is
 * what the API/webhook surfaces as `assignees` so the frontend can show who owns
 * a reviewed PR (a PR often has no assignee, only an author).
 */
export function subjectOwners(subject: NormalizedSubject): string[] {
  if (subject.assignees.length > 0) return subject.assignees;
  return subject.author ? [subject.author] : [];
}

/**
 * Human-readable trigger reasons, stored on the task and surfaced in the
 * API/webhook. Free-form text by contract, but always drawn from this set so the
 * frontend sees stable values. `comment`/`newCommits` are subject-aware (see the
 * helpers below) — "PR" vs "issue" — so a consumer can read them verbatim.
 */
export const TRIGGER_REASON = {
  issueAssigned: "assigned to issue",
  prAssigned: "assigned to PR",
  reviewRequested: "review requested",
  reviewSubmitted: "PR review submitted",
  prApproved: "PR approved",
  manual: "manual run",
} as const;

/** "new commits on PR" — the PR was opened/reopened or received a new push. */
export function newCommitsReason(): string {
  return "new commits on PR";
}

/** "new comment on {issue|PR}" for the subject the comment landed on. */
export function commentReason(subject: NormalizedSubject): string {
  return subject.type === "pull_request"
    ? "new comment on PR"
    : "new comment on issue";
}

/**
 * The reason for a follow-up carried by a comment/review event: a submitted PR
 * review (review body or inline review comment) vs. a plain comment. Derived
 * from the DraftFollowUpInput's eventLabel ("comment" | "review" | "inline
 * review comment").
 */
export function followUpReason(
  subject: NormalizedSubject,
  eventLabel: string | undefined,
): string {
  return eventLabel?.includes("review")
    ? TRIGGER_REASON.reviewSubmitted
    : commentReason(subject);
}

// The webhook payloads are loosely typed; we read only the fields we need.
/* eslint-disable @typescript-eslint/no-explicit-any */
function names(arr: any[] | undefined, key: string): string[] {
  return Array.isArray(arr) ? arr.map((x) => x?.[key]).filter(Boolean) : [];
}

export function subjectFromIssue(issue: any): NormalizedSubject {
  // issue_comment on a PR still arrives under `issue`, flagged by `pull_request`.
  const isPr = !!issue.pull_request;
  return {
    type: isPr ? "pull_request" : "issue",
    number: issue.number,
    state: issue.state === "closed" ? "closed" : "open",
    assignees: names(issue.assignees, "login"),
    requestedReviewers: [],
    title: issue.title ?? "",
    body: issue.body ?? "",
    // `issue.user` is the opener — the PR author for a PR-flavored issue payload.
    author: issue.user?.login ?? undefined,
  };
}

function subjectFromPull(pr: any): NormalizedSubject {
  return {
    type: "pull_request",
    number: pr.number,
    state: pr.state === "closed" ? "closed" : "open",
    assignees: names(pr.assignees, "login"),
    requestedReviewers: names(pr.requested_reviewers, "login"),
    title: pr.title ?? "",
    body: pr.body ?? "",
    author: pr.user?.login ?? undefined,
    headRef: pr.head?.ref,
    headRepoFullName: pr.head?.repo?.full_name ?? undefined,
    baseRef: pr.base?.ref,
    merged: !!pr.merged,
  };
}

/** Normalize a raw GitHub webhook payload, or null if not actionable. */
export function normalize(event: string, payload: any): Normalized | null {
  const repoFullName: string | undefined = payload?.repository?.full_name;
  if (!repoFullName) return null;
  const action: string = payload?.action ?? "";
  const senderLogin: string = payload?.sender?.login ?? "";
  const defaultBranch: string | undefined = payload?.repository?.default_branch;
  const base = { event, action, repoFullName, defaultBranch, senderLogin };

  switch (event) {
    case "issues":
      return {
        ...base,
        subject: subjectFromIssue(payload.issue),
        targetLogin: payload.assignee?.login,
      };
    case "pull_request":
      return {
        ...base,
        subject: subjectFromPull(payload.pull_request),
        // review_requested carries the requested reviewer (user or team).
        targetLogin: payload.requested_reviewer?.login,
      };
    case "issue_comment":
      if (action !== "created") return null;
      return {
        ...base,
        subject: subjectFromIssue(payload.issue),
        comment: {
          body: payload.comment?.body ?? "",
          authorLogin: payload.comment?.user?.login ?? "",
          htmlUrl: payload.comment?.html_url ?? "",
          eventLabel: "comment",
        },
      };
    case "pull_request_review":
      if (action !== "submitted") return null;
      return {
        ...base,
        subject: subjectFromPull(payload.pull_request),
        pullRequestReview: {
          state: String(payload.review?.state ?? "").toLowerCase(),
          body: payload.review?.body ?? "",
          authorLogin: payload.review?.user?.login ?? "",
          htmlUrl: payload.review?.html_url ?? null,
        },
        comment: {
          body: payload.review?.body ?? "",
          authorLogin: payload.review?.user?.login ?? "",
          htmlUrl: payload.review?.html_url ?? "",
          eventLabel: "review",
          location: payload.review?.state
            ? `review: ${String(payload.review.state).toLowerCase()}`
            : undefined,
        },
      };
    case "pull_request_review_comment":
      if (action !== "created") return null;
      return {
        ...base,
        subject: subjectFromPull(payload.pull_request),
        comment: {
          body: payload.comment?.body ?? "",
          authorLogin: payload.comment?.user?.login ?? "",
          htmlUrl: payload.comment?.html_url ?? "",
          eventLabel: "inline review comment",
          location: payload.comment?.path
            ? `${payload.comment.path}:${
                payload.comment?.line ?? payload.comment?.original_line ?? "?"
              }`
            : undefined,
        },
      };
    case "push":
      return { ...base, subject: null, pushRef: payload.ref };
    default:
      return null;
  }
}
