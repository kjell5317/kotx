// Domain types mirroring the DB schema (SPEC §4) and queue contract (SPEC §7).

// implement       — Branch 1: refine an issue/PR into a TASK.md, then (on start)
//                   write code, push the branch, and comment the summary.
// resolve_conflict — Branch 2: resolve an unmergeable PR's conflicts and push.
// review          — Branch 3: read-only review of a PR → REVIEW.md (no commits).
export type TaskKind = "implement" | "resolve_conflict" | "review";

export type TaskState =
  | "drafting" // Branch 1: refinement run in flight (producing TASK.md)
  | "draft" // Branch 1: TASK.md ready, waiting for me to start it
  | "queued"
  | "running"
  | "awaiting_approval" // Branch 3: REVIEW.md ready, waiting for me to post it
  | "awaiting_external" // my changes are pushed; waiting on others to review/merge
  | "done"
  | "failed"
  | "cancelled";

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "done",
  "failed",
  "cancelled",
]);

// States that occupy the single active slot per (repo, subject). awaiting_external
// and terminal states are NOT active — a follow-up comment may open a new task.
export const ACTIVE_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "drafting",
  "draft",
  "queued",
  "running",
  "awaiting_approval",
]);

/** Human-facing status for the external frontend. */
export function displayStatus(state: TaskState): string {
  switch (state) {
    case "drafting":
      return "preparing task";
    case "draft":
    case "awaiting_approval":
      return "waiting on my approval";
    case "awaiting_external":
      return "waiting on external approval";
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      // legacy/unknown enum values (e.g. a pre-consolidation 'timed_out' row)
      return String(state);
  }
}

export type RunOutcome =
  | "completed"
  | "needs_approval"
  | "failed"
  | "timed_out"
  | "cancelled";

export type SubjectType = "issue" | "pull_request";

/** My relationship to the subject (drives which list the frontend shows it in). */
export type TaskRole = "assignee" | "reviewer";

export interface Task {
  id: number;
  repo_full_name: string;
  subject_type: SubjectType;
  subject_number: number;
  kind: TaskKind;
  role: TaskRole;
  state: TaskState;
  state_reason: string | null;
  branch_name: string | null;
  pr_number: number | null;
  triggered_by: string;
  trigger_comment_url: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TaskRun {
  id: number;
  task_id: number;
  attempt: number;
  worktree_path: string;
  container_name: string | null;
  outcome: RunOutcome | null;
  exit_code: number | null;
  started_at: Date | null;
  finished_at: Date | null;
  jsonl_path: string | null;
  result_md: string | null;
}

// BullMQ job payload (SPEC §7).
// phase distinguishes Branch 1's two runs of the same task: the read-only
// refinement that produces TASK.md ("draft") and the write run kicked off when I
// press start ("execute"). Other kinds always run a single "execute" phase.
export type JobPhase = "draft" | "execute";

export interface TaskJob {
  taskId: number;
  taskRunId: number;
  kind: TaskKind;
  phase: JobPhase;
  repoFullName: string;
  subject: { type: SubjectType; number: number };
}

export const TASK_QUEUE_NAME = "tasks";
