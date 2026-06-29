import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  hitlRequestSchema,
  type HitlRequestPayload,
  type RunOutcome,
} from "@kotx/shared";

// Agent artifacts Codex writes into the worktree. They must be read, then
// removed before committing so they never land in the PR.
const ARTIFACTS = [
  "AGENT_RESULT.md",
  "COMMIT_MSG.md",
  "REVIEW.md",
  "HITL_REQUEST.json",
] as const;

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export interface Artifacts {
  resultMd: string | null;
  commitMsg: string | null;
  review: string | null;
  hitl: HitlRequestPayload | null;
  hitlInvalid: boolean; // HITL_REQUEST.json present but failed schema validation
}

export async function readArtifacts(worktreePath: string): Promise<Artifacts> {
  const [resultMd, commitMsg, review, hitlRaw] = await Promise.all([
    readIfPresent(join(worktreePath, "AGENT_RESULT.md")),
    readIfPresent(join(worktreePath, "COMMIT_MSG.md")),
    readIfPresent(join(worktreePath, "REVIEW.md")),
    readIfPresent(join(worktreePath, "HITL_REQUEST.json")),
  ]);

  let hitl: HitlRequestPayload | null = null;
  let hitlInvalid = false;
  if (hitlRaw !== null) {
    try {
      hitl = hitlRequestSchema.parse(JSON.parse(hitlRaw));
    } catch {
      hitlInvalid = true;
    }
  }
  return { resultMd, commitMsg, review, hitl, hitlInvalid };
}

export async function deleteArtifacts(worktreePath: string): Promise<void> {
  await Promise.all(
    ARTIFACTS.map((f) =>
      rm(join(worktreePath, f), { force: true }).catch(() => {}),
    ),
  );
}

/**
 * Classify the run outcome. Output files are authoritative; the exit code only
 * breaks ties (SPEC §D6/§10.4).
 */
export function classifyOutcome(input: {
  exitCode: number;
  artifacts: Artifacts;
  killedByCancel: boolean;
  killedByTimeout: boolean;
}): RunOutcome {
  if (input.killedByCancel) return "cancelled";
  if (input.killedByTimeout) return "timed_out";
  if (input.artifacts.hitl && !input.artifacts.hitlInvalid)
    return "needs_approval";
  if (input.artifacts.hitlInvalid) return "failed"; // malformed HITL request
  if (input.exitCode === 0 && input.artifacts.resultMd !== null)
    return "completed";
  return "failed";
}
