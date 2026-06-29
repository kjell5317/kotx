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

// BullMQ job payload (SPEC §7)
export type JobMode = "implement" | "review";

export interface TaskJob {
  taskId: number;
  taskRunId: number;
  mode: JobMode;
  repoFullName: string;
  subject: { type: SubjectType; number: number };
}

export const TASK_QUEUE_NAME = "tasks";

// Parsed intent from a webhook (SPEC §6.3)
export type AgentCommand = "run" | "review" | "stop" | "status";

export interface Intent {
  kind: TaskKind | null; // null for stop/status
  command: AgentCommand | null; // null when triggered purely by a label
  source: "command" | "label";
}
