import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RunOutcome } from "@kotx/shared";

// Files Codex writes into the worktree. The write-kinds (implement,
// resolve_conflict) produce AGENT_RESULT.md + COMMIT_MSG.md, which are read and
// then removed before committing so they never land on the branch. An
// issue-origin implement also produces PR_TITLE.md/PR_BODY.md (the proposed PR),
// likewise read then removed. The read-only kinds produce TASK.md (draft) or
// REVIEW.md (review), which are read off the throwaway worktree and never committed.
const COMMIT_ARTIFACTS = [
  "AGENT_RESULT.md",
  "COMMIT_MSG.md",
  "PR_TITLE.md",
  "PR_BODY.md",
] as const;

// Candidate locations GitHub honors for a pull-request template, in priority order.
const PR_TEMPLATE_PATHS = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
] as const;

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Read a single named artifact from the worktree (null if absent). */
export function readArtifact(
  worktreePath: string,
  name: string,
): Promise<string | null> {
  return readIfPresent(join(worktreePath, name));
}

export interface Artifacts {
  resultMd: string | null; // the summary Codex wrote (becomes the comment body)
  commitMsg: string | null;
  prTitle: string | null; // issue-origin implement: proposed PR title
  prBody: string | null; // issue-origin implement: proposed PR description
}

export async function readArtifacts(worktreePath: string): Promise<Artifacts> {
  const [resultMd, commitMsg, prTitle, prBody] = await Promise.all([
    readIfPresent(join(worktreePath, "AGENT_RESULT.md")),
    readIfPresent(join(worktreePath, "COMMIT_MSG.md")),
    readIfPresent(join(worktreePath, "PR_TITLE.md")),
    readIfPresent(join(worktreePath, "PR_BODY.md")),
  ]);
  return { resultMd, commitMsg, prTitle, prBody };
}

/** The repo's PR template (first one that exists), or null. */
export async function readPrTemplate(
  worktreePath: string,
): Promise<string | null> {
  for (const rel of PR_TEMPLATE_PATHS) {
    const content = await readIfPresent(join(worktreePath, rel));
    if (content !== null) return content;
  }
  return null;
}

export async function deleteArtifacts(worktreePath: string): Promise<void> {
  await Promise.all(
    COMMIT_ARTIFACTS.map((f) =>
      rm(join(worktreePath, f), { force: true }).catch(() => {}),
    ),
  );
}

/**
 * Output files are authoritative; the exit code only breaks ties (SPEC §D6).
 * `producedOutput` = the run's expected primary artifact exists (AGENT_RESULT.md
 * for write-kinds, TASK.md for draft, REVIEW.md for review).
 */
export function classifyOutcome(input: {
  exitCode: number;
  producedOutput: boolean;
  killedByCancel: boolean;
  killedByTimeout: boolean;
}): RunOutcome {
  if (input.killedByCancel) return "cancelled";
  if (input.killedByTimeout) return "timed_out";
  if (input.exitCode === 0 && input.producedOutput) return "completed";
  return "failed";
}
