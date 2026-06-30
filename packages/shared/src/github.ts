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
