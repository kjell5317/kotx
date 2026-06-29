import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { authedRemote, loadEnv, splitRepo } from "@kotx/shared";
import { run } from "./exec.js";

const HEADS = "+refs/heads/*:refs/remotes/origin/*";
const PULLS = "+refs/pull/*/head:refs/remotes/origin/pull/*";

export function mirrorPath(repoFullName: string): string {
  const [owner, repo] = splitRepo(repoFullName);
  return join(loadEnv().agentDataDir, "repos", `${owner}__${repo}.git`);
}

/**
 * Ensure a bare mirror exists, then fetch all heads + PR heads into the
 * `refs/remotes/origin/*` namespace. Agent branches live in `refs/heads/*` and
 * are therefore safe from `--prune` (SPEC §9.1).
 */
export async function ensureMirrorFetched(
  repoFullName: string,
  token: string,
): Promise<string> {
  const mirror = mirrorPath(repoFullName);
  if (!existsSync(join(mirror, "HEAD"))) {
    await mkdir(mirror, { recursive: true });
    await run("git", ["init", "--bare", mirror]);
  }
  const url = authedRemote(repoFullName, token);
  await run("git", ["-C", mirror, "fetch", "--prune", url, HEADS, PULLS]);
  return mirror;
}

/**
 * Create a fresh worktree on the agent branch off the base branch. Uses `-B`
 * (create-or-reset) so a leftover branch from a previous failed attempt doesn't
 * block the run, and prunes stale worktree admin entries first. An implement
 * attempt always starts fresh from base, so resetting the branch is correct.
 */
export async function addImplementWorktree(
  repoFullName: string,
  worktreePath: string,
  branchName: string,
  baseBranch: string,
): Promise<void> {
  const mirror = mirrorPath(repoFullName);
  await run("git", ["-C", mirror, "worktree", "prune"]);
  await run("git", [
    "-C",
    mirror,
    "worktree",
    "add",
    "-B",
    branchName,
    worktreePath,
    `refs/remotes/origin/${baseBranch}`,
  ]);
}

/**
 * GitHub's default branch name for an issue: "<number>-<slugified-title>"
 * (e.g. issue #31 "Add metadata index" → "31-add-metadata-index").
 */
export function issueBranchName(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return slug ? `${issueNumber}-${slug}` : `${issueNumber}`;
}

/** Stage everything and commit. Returns false if there was nothing to commit. */
export async function commitAll(
  worktreePath: string,
  commitMsgFile: string,
): Promise<boolean> {
  const env = loadEnv();
  await run("git", ["-C", worktreePath, "add", "-A"]);
  const { stdout } = await run("git", [
    "-C",
    worktreePath,
    "status",
    "--porcelain",
  ]);
  if (stdout.trim() === "") return false;
  await run("git", [
    "-C",
    worktreePath,
    "-c",
    `user.name=${env.github.committerName}`,
    "-c",
    `user.email=${env.github.committerEmail}`,
    "commit",
    "-F",
    commitMsgFile,
  ]);
  return true;
}

/** Push the agent branch to GitHub over an ephemeral authed HTTPS remote. */
export async function pushBranch(
  repoFullName: string,
  branchName: string,
  token: string,
): Promise<void> {
  const mirror = mirrorPath(repoFullName);
  const url = authedRemote(repoFullName, token);
  await run("git", [
    "-C",
    mirror,
    "push",
    url,
    `refs/heads/${branchName}:refs/heads/${branchName}`,
  ]);
}

export async function removeWorktree(
  repoFullName: string,
  worktreePath: string,
): Promise<void> {
  const mirror = mirrorPath(repoFullName);
  if (!existsSync(worktreePath)) return;
  await run("git", [
    "-C",
    mirror,
    "worktree",
    "remove",
    "--force",
    worktreePath,
  ]).catch(() => {
    /* best-effort cleanup */
  });
}
