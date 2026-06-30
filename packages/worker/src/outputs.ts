import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RunOutcome } from "@kotx/shared";

// Files Codex writes into the worktree. The write-kinds (implement,
// resolve_conflict) produce AGENT_RESULT.md + COMMIT_MSG.md, which are read and
// then removed before committing so they never land on the branch. The
// read-only kinds produce TASK.md (draft) or REVIEW.md (review), which are read
// off the throwaway worktree and never committed.
const COMMIT_ARTIFACTS = ["AGENT_RESULT.md", "COMMIT_MSG.md"] as const;

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
}

export async function readArtifacts(worktreePath: string): Promise<Artifacts> {
  const [resultMd, commitMsg] = await Promise.all([
    readIfPresent(join(worktreePath, "AGENT_RESULT.md")),
    readIfPresent(join(worktreePath, "COMMIT_MSG.md")),
  ]);
  return { resultMd, commitMsg };
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
