import { postIssueComment, splitRepo, type SubjectType } from "@kotx/shared";
import type { Octokit } from "@octokit/rest";

export interface DiscussionItem {
  author: string;
  when: string;
  location?: string; // "review: changes_requested" or "path/to/file.ts:42"
  body: string;
}

export interface SubjectDetails {
  title: string;
  body: string;
  comments: DiscussionItem[];
  // PRs only:
  headRef?: string;
  headRepoFullName?: string;
}

/**
 * The full discussion: conversation comments (issues + PRs), plus PR review
 * bodies and inline review comments, merged chronologically. This is usually
 * where the actual instructions for a follow-up live.
 */
async function fetchDiscussion(
  octokit: Octokit,
  owner: string,
  repo: string,
  type: SubjectType,
  number: number,
): Promise<DiscussionItem[]> {
  const items: DiscussionItem[] = [];

  const conv = await octokit.issues.listComments({
    owner,
    repo,
    issue_number: number,
    per_page: 100,
  });
  for (const c of conv.data) {
    const body = (c.body ?? "").trim();
    if (body)
      items.push({
        author: c.user?.login ?? "?",
        when: c.created_at,
        body,
      });
  }

  if (type === "pull_request") {
    const reviews = await octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    });
    for (const r of reviews.data) {
      const body = (r.body ?? "").trim();
      const state = r.state ?? "";
      const meaningful = ["CHANGES_REQUESTED", "APPROVED", "DISMISSED"].includes(
        state,
      );
      if (body || meaningful)
        items.push({
          author: r.user?.login ?? "?",
          when: r.submitted_at ?? "",
          location: `review: ${state.toLowerCase()}`,
          body,
        });
    }

    const inline = await octokit.pulls.listReviewComments({
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    });
    for (const c of inline.data) {
      const body = (c.body ?? "").trim();
      if (!body) continue;
      const line = c.line ?? c.original_line ?? "?";
      items.push({
        author: c.user?.login ?? "?",
        when: c.created_at,
        location: `${c.path}:${line}`,
        body,
      });
    }
  }

  items.sort((a, b) => (a.when < b.when ? -1 : a.when > b.when ? 1 : 0));
  return items;
}

export async function fetchSubject(
  octokit: Octokit,
  repoFullName: string,
  type: SubjectType,
  number: number,
): Promise<SubjectDetails> {
  const [owner, repo] = splitRepo(repoFullName);
  const comments = await fetchDiscussion(octokit, owner, repo, type, number);
  if (type === "pull_request") {
    const res = await octokit.pulls.get({ owner, repo, pull_number: number });
    return {
      title: res.data.title ?? "",
      body: res.data.body ?? "",
      comments,
      headRef: res.data.head?.ref,
      headRepoFullName: res.data.head?.repo?.full_name ?? undefined,
    };
  }
  const res = await octokit.issues.get({ owner, repo, issue_number: number });
  return { title: res.data.title ?? "", body: res.data.body ?? "", comments };
}

/** Post the work summary as a plain comment (no machine-authored framing). */
export async function postSummary(
  octokit: Octokit,
  repoFullName: string,
  subjectNumber: number,
  body: string,
): Promise<void> {
  await postIssueComment(octokit, repoFullName, subjectNumber, body);
}
