import { postIssueComment, splitRepo, type SubjectType } from "@kotx/shared";
import type { Octokit } from "@octokit/rest";

export interface SubjectDetails {
  title: string;
  body: string;
  // PRs only:
  headRef?: string;
  headRepoFullName?: string;
}

export async function fetchSubject(
  octokit: Octokit,
  repoFullName: string,
  type: SubjectType,
  number: number,
): Promise<SubjectDetails> {
  const [owner, repo] = splitRepo(repoFullName);
  if (type === "pull_request") {
    const res = await octokit.pulls.get({ owner, repo, pull_number: number });
    return {
      title: res.data.title ?? "",
      body: res.data.body ?? "",
      headRef: res.data.head?.ref,
      headRepoFullName: res.data.head?.repo?.full_name ?? undefined,
    };
  }
  const res = await octokit.issues.get({ owner, repo, issue_number: number });
  return { title: res.data.title ?? "", body: res.data.body ?? "" };
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

export async function postFailureComment(
  octokit: Octokit,
  repoFullName: string,
  subjectNumber: number,
  reason: string,
): Promise<void> {
  await postIssueComment(
    octokit,
    repoFullName,
    subjectNumber,
    `Couldn't complete the requested changes — ${reason}.`,
  );
}
