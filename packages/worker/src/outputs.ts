import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RunOutcome } from "@kotx/shared";

// Artifacts Codex writes into the worktree. They're read, then removed before
// committing so they never land on the branch.
const ARTIFACTS = ["AGENT_RESULT.md", "COMMIT_MSG.md"] as const;

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
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
    ARTIFACTS.map((f) =>
      rm(join(worktreePath, f), { force: true }).catch(() => {}),
    ),
  );
}

/** Output files are authoritative; the exit code only breaks ties (SPEC §D6). */
export function classifyOutcome(input: {
  exitCode: number;
  artifacts: Artifacts;
  killedByCancel: boolean;
  killedByTimeout: boolean;
}): RunOutcome {
  if (input.killedByCancel) return "cancelled";
  if (input.killedByTimeout) return "timed_out";
  if (input.exitCode === 0 && input.artifacts.resultMd !== null)
    return "completed";
  return "failed";
}
