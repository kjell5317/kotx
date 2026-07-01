import { Octokit } from "@octokit/rest";
import { loadEnv } from "./config.js";

let octokit: Octokit | undefined;

/** A single Octokit authenticated with the personal access token. */
export function getOctokit(): Octokit {
  if (!octokit) octokit = new Octokit({ auth: loadEnv().github.token });
  return octokit;
}

/**
 * Invisible marker appended to every comment the agent posts. GitHub renders an
 * HTML comment as nothing, so it's hidden in the UI but preserved in the stored
 * body. The comment-trigger guards skip comments carrying this marker, which lets
 * a human follow-up posted from the SAME account as the agent still trigger a run
 * while the agent's own summaries/reviews/failures never re-trigger themselves.
 */
export const AGENT_COMMENT_MARKER = "<!-- kotx:agent-comment -->";

/** True if a comment body was authored by the agent (carries the marker). */
export function isAgentComment(body: string): boolean {
  return body.includes(AGENT_COMMENT_MARKER);
}

export function splitRepo(fullName: string): [string, string] {
  const idx = fullName.indexOf("/");
  if (idx < 0) throw new Error(`Invalid repo full name: ${fullName}`);
  return [fullName.slice(0, idx), fullName.slice(idx + 1)];
}

/** The PAT, used to authenticate git-over-HTTPS for fetch/push. */
export function gitToken(): string {
  return loadEnv().github.token;
}

/**
 * Authenticated HTTPS remote for a PAT:
 * https://oauth2:TOKEN@github.com/owner/repo.git
 * (token is never persisted in a remote — injected per fetch/push, then dropped)
 */
export function authedRemote(repoFullName: string, token: string): string {
  return `https://oauth2:${token}@github.com/${repoFullName}.git`;
}

export async function postIssueComment(
  octokit: Octokit,
  repoFullName: string,
  issueNumber: number,
  body: string,
): Promise<number> {
  const [owner, repo] = splitRepo(repoFullName);
  const res = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    // stamp so the comment-trigger guards don't re-trigger on the agent's own posts
    body: `${body}\n\n${AGENT_COMMENT_MARKER}`,
  });
  return res.data.id;
}

/** Submit an approving PR review. Returns the review id. */
export async function approvePullRequestReview(
  octokit: Octokit,
  repoFullName: string,
  pullNumber: number,
  body: string,
): Promise<number> {
  const [owner, repo] = splitRepo(repoFullName);
  const trimmed = body.trim();
  const res = await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    event: "APPROVE",
    ...(trimmed === "" ? {} : { body }),
  });
  return res.data.id;
}

/** Open a pull request. Returns the new PR's number and html url. */
export async function openPullRequest(
  octokit: Octokit,
  repoFullName: string,
  opts: { title: string; body: string; head: string; base: string },
): Promise<{ number: number; htmlUrl: string }> {
  const [owner, repo] = splitRepo(repoFullName);
  const res = await octokit.pulls.create({
    owner,
    repo,
    title: opts.title,
    body: opts.body,
    head: opts.head,
    base: opts.base,
  });
  return { number: res.data.number, htmlUrl: res.data.html_url };
}

/**
 * Bring `branch` up to date by merging `base` (e.g. the default branch) into it,
 * server-side. "up_to_date" means nothing to merge; "conflict" means the merge
 * couldn't be performed automatically (needs a fresh run to resolve).
 */
export async function updateBranchFromBase(
  octokit: Octokit,
  repoFullName: string,
  branch: string,
  base: string,
): Promise<"updated" | "up_to_date" | "conflict"> {
  const [owner, repo] = splitRepo(repoFullName);
  try {
    const res = await octokit.repos.merge({ owner, repo, base: branch, head: base });
    // 201 = merge commit created; 204 = already up to date (nothing to merge)
    return res.status === 201 ? "updated" : "up_to_date";
  } catch (err) {
    if ((err as { status?: number }).status === 409) return "conflict";
    throw err;
  }
}
