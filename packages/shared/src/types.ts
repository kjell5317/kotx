// Domain types mirroring the DB schema (SPEC §4) and queue contract (SPEC §7).

export type TaskKind = "implement" | "review";

export type TaskState =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "done"
  | "failed"
  | "cancelled"
  | "timed_out";

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "done",
  "failed",
  "cancelled",
  "timed_out",
]);

export type RunOutcome =
  | "completed"
  | "needs_approval"
  | "failed"
  | "timed_out"
  | "cancelled";

export type HitlState = "open" | "approved" | "rejected" | "expired";

export type SubjectType = "issue" | "pull_request";

export interface Task {
  id: number;
  repo_full_name: string;
  subject_type: SubjectType;
  subject_number: number;
  kind: TaskKind;
  state: TaskState;
  branch_name: string | null;
  pr_number: number | null;
  triggered_by: string;
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

export interface HitlRequest {
  id: number;
  task_id: number;
  task_run_id: number;
  state: HitlState;
  reason: string;
  proposed_action: string;
  risk: string;
  alternatives: string[];
  comment_id: number | null;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
}

// BullMQ job payload (SPEC §7)
export type JobMode = "implement" | "review" | "resume";

export interface TaskJob {
  taskId: number;
  taskRunId: number;
  mode: JobMode;
  repoFullName: string;
  subject: { type: SubjectType; number: number };
  // resume only:
  hitlRequestId?: number;
  approvalNote?: string;
}

export const TASK_QUEUE_NAME = "tasks";

// Parsed intent from a webhook (SPEC §6.3)
export type AgentCommand =
  | "run"
  | "review"
  | "stop"
  | "status"
  | "approve"
  | "reject";

export interface Intent {
  kind: TaskKind | null; // null for stop/status/approve/reject
  command: AgentCommand | null; // null when triggered purely by a label
  source: "command" | "label";
}
