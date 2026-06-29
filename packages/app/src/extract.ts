import type { SubjectType } from "@kotx/shared";

export interface NormalizedSubject {
  type: SubjectType;
  number: number;
  state: "open" | "closed";
  assignees: string[];
  labels: string[];
  title: string;
  body: string;
}

export interface Normalized {
  event: string;
  action: string;
  repoFullName: string;
  senderLogin: string;
  subject: NormalizedSubject | null;
  comment?: { body: string; authorLogin: string; htmlUrl: string };
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
    labels: names(issue.labels, "name"),
    title: issue.title ?? "",
    body: issue.body ?? "",
  };
}

function subjectFromPull(pr: any): NormalizedSubject {
  return {
    type: "pull_request",
    number: pr.number,
    state: pr.state === "closed" ? "closed" : "open",
    assignees: names(pr.assignees, "login"),
    labels: names(pr.labels, "name"),
    title: pr.title ?? "",
    body: pr.body ?? "",
  };
}

/** Normalize a raw GitHub webhook payload, or null if not actionable. */
export function normalize(event: string, payload: any): Normalized | null {
  const repoFullName: string | undefined = payload?.repository?.full_name;
  if (!repoFullName) return null;
  const action: string = payload?.action ?? "";
  const senderLogin: string = payload?.sender?.login ?? "";

  switch (event) {
    case "issues":
      return {
        event,
        action,
        repoFullName,
        senderLogin,
        subject: subjectFromIssue(payload.issue),
      };
    case "pull_request":
      return {
        event,
        action,
        repoFullName,
        senderLogin,
        subject: subjectFromPull(payload.pull_request),
      };
    case "issue_comment":
      if (action !== "created") return null; // only act on new comments
      return {
        event,
        action,
        repoFullName,
        senderLogin,
        subject: subjectFromIssue(payload.issue),
        comment: {
          body: payload.comment?.body ?? "",
          authorLogin: payload.comment?.user?.login ?? "",
          htmlUrl: payload.comment?.html_url ?? "",
        },
      };
    case "pull_request_review_comment":
      if (action !== "created") return null;
      return {
        event,
        action,
        repoFullName,
        senderLogin,
        subject: subjectFromPull(payload.pull_request),
        comment: {
          body: payload.comment?.body ?? "",
          authorLogin: payload.comment?.user?.login ?? "",
          htmlUrl: payload.comment?.html_url ?? "",
        },
      };
    default:
      return null;
  }
}
