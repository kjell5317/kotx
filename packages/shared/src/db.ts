import { join } from "node:path";
import pg from "pg";
import { loadEnv } from "./config.js";
import type {
  RunOutcome,
  SubjectType,
  Task,
  TaskKind,
  TaskRole,
  TaskRun,
  TaskState,
} from "./types.js";

// The states that hold the single active slot per (repo, subject). Mirrors the
// partial unique index `uq_one_active_task` (migration 1700000003000).
const ACTIVE_STATE_SQL = `('drafting','draft','queued','running','awaiting_approval')`;
// Includes the legacy 'timed_out'/'discarded' enum values (still present in the
// Postgres enum) so any row that escaped migration 1700000005000 is still treated
// as terminal — excluded from "active" and never resurrected by PR reconciliation.
const TERMINAL_STATE_SQL = `('done','failed','cancelled','timed_out','discarded')`;

const { Pool } = pg;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) pool = new Pool({ connectionString: loadEnv().databaseUrl });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

const UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}

// ── github_deliveries ───────────────────────────────────────────────────────

/** Returns true if this delivery is new (inserted), false if already seen. */
export async function recordDelivery(
  deliveryId: string,
  event: string,
): Promise<boolean> {
  const res = await getPool().query(
    `INSERT INTO github_deliveries (delivery_id, event) VALUES ($1, $2)
     ON CONFLICT (delivery_id) DO NOTHING`,
    [deliveryId, event],
  );
  return (res.rowCount ?? 0) > 0;
}

// ── tasks ─────────────────────────────────────────────────────────────────

export async function findActiveTask(
  repoFullName: string,
  subjectType: SubjectType,
  subjectNumber: number,
): Promise<Task | undefined> {
  const res = await getPool().query<Task>(
    `SELECT * FROM tasks
     WHERE repo_full_name = $1 AND subject_type = $2 AND subject_number = $3
       AND state::text IN ${ACTIVE_STATE_SQL}`,
    [repoFullName, subjectType, subjectNumber],
  );
  return res.rows[0];
}

/** Most recent prior implement task for the same subject, used by follow-up drafts. */
export async function findLatestPriorImplementTask(input: {
  repoFullName: string;
  subjectType: SubjectType;
  subjectNumber: number;
  excludeTaskId: number;
}): Promise<Task | undefined> {
  const res = await getPool().query<Task>(
    `SELECT * FROM tasks
     WHERE repo_full_name = $1
       AND subject_type = $2
       AND subject_number = $3
       AND kind = 'implement'
       AND id <> $4
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
    [
      input.repoFullName,
      input.subjectType,
      input.subjectNumber,
      input.excludeTaskId,
    ],
  );
  return res.rows[0];
}

/**
 * Whether any task (in any state) exists for a subject. The poller uses this to
 * fire assignment/review triggers at most once per subject — without labels to
 * clear, level-triggered polling would otherwise re-create tasks every tick.
 */
export async function hasAnyTask(
  repoFullName: string,
  subjectType: SubjectType,
  subjectNumber: number,
): Promise<boolean> {
  const res = await getPool().query(
    `SELECT 1 FROM tasks
     WHERE repo_full_name = $1 AND subject_type = $2 AND subject_number = $3
     LIMIT 1`,
    [repoFullName, subjectType, subjectNumber],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getTask(id: number): Promise<Task | undefined> {
  const res = await getPool().query<Task>(`SELECT * FROM tasks WHERE id = $1`, [
    id,
  ]);
  return res.rows[0];
}

/** Deterministic, per-run worktree path: <dataDir>/worktrees/<runId>. */
export function worktreePathFor(dataDir: string, runId: number): string {
  return join(dataDir, "worktrees", String(runId));
}

/** Per-run output dir: <dataDir>/runs/<runId> (holds PROMPT.md, codex.jsonl). */
export function runDirFor(dataDir: string, runId: number): string {
  return join(dataDir, "runs", String(runId));
}

/**
 * Per-task dir: <dataDir>/tasks/<taskId>. Holds the durable artifacts the
 * frontend reads — TASK.md (the reviewable brief) and REVIEW.md — which persist
 * across runs (a draft refresh, then the execute run) and survive human edits.
 */
export function taskDirFor(dataDir: string, taskId: number): string {
  return join(dataDir, "tasks", String(taskId));
}

/**
 * Creates a task + its first run atomically, deriving the run's worktree path
 * from the generated run id. Returns undefined if an active task already exists
 * for the subject (unique-index race) — caller treats it as "already running".
 */
export async function createTaskWithRun(input: {
  repoFullName: string;
  subjectType: SubjectType;
  subjectNumber: number;
  subjectTitle: string | null;
  kind: TaskKind;
  role: TaskRole;
  // initial lifecycle state: 'drafting' for Branch 1 (a draft run produces
  // TASK.md), 'queued' for Branch 2/3 (auto-run, no approval gate).
  initialState: Extract<TaskState, "drafting" | "queued">;
  branchName: string | null;
  triggeredBy: string;
  triggerCommentUrl?: string | null;
  dataDir: string;
}): Promise<{ task: Task; run: TaskRun } | undefined> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    let task: Task;
    try {
      const t = await client.query<Task>(
        `INSERT INTO tasks
           (repo_full_name, subject_type, subject_number, subject_title, kind, role, state, branch_name, triggered_by, trigger_comment_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          input.repoFullName,
          input.subjectType,
          input.subjectNumber,
          input.subjectTitle,
          input.kind,
          input.role,
          input.initialState,
          input.branchName,
          input.triggeredBy,
          input.triggerCommentUrl ?? null,
        ],
      );
      task = t.rows[0]!;
    } catch (err) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(err)) return undefined;
      throw err;
    }
    const run = await insertRun(client, task.id, 1, input.dataDir);
    await client.query("COMMIT");
    return { task, run };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Insert a run row and backfill its worktree path from the generated id. */
async function insertRun(
  client: pg.PoolClient,
  taskId: number,
  attempt: number,
  dataDir: string,
): Promise<TaskRun> {
  const r = await client.query<TaskRun>(
    `INSERT INTO task_runs (task_id, attempt, worktree_path)
     VALUES ($1, $2, '') RETURNING *`,
    [taskId, attempt],
  );
  const run = r.rows[0]!;
  const path = worktreePathFor(dataDir, run.id);
  const u = await client.query<TaskRun>(
    `UPDATE task_runs SET worktree_path = $2 WHERE id = $1 RETURNING *`,
    [run.id, path],
  );
  return u.rows[0]!;
}

/**
 * Add the next attempt run for an existing task (e.g. a Branch 1 follow-up
 * refreshes the draft, or `start` kicks off the execute phase). Returns the new
 * run; the caller sets the task state and enqueues the job.
 */
export async function addRun(
  taskId: number,
  dataDir: string,
): Promise<TaskRun> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const prev = await client.query<{ attempt: number }>(
      `SELECT COALESCE(MAX(attempt), 0) AS attempt FROM task_runs WHERE task_id = $1`,
      [taskId],
    );
    const next = (prev.rows[0]?.attempt ?? 0) + 1;
    const run = await insertRun(client, taskId, next, dataDir);
    await client.query("COMMIT");
    return run;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function setTaskState(
  id: number,
  state: TaskState,
  reason: string | null = null,
): Promise<void> {
  await getPool().query(`UPDATE tasks SET state = $2, state_reason = $3 WHERE id = $1`, [
    id,
    state,
    reason,
  ]);
}

export async function setTaskBranch(
  id: number,
  branchName: string,
): Promise<void> {
  await getPool().query(`UPDATE tasks SET branch_name = $2 WHERE id = $1`, [
    id,
    branchName,
  ]);
}

export async function setTaskPr(id: number, prNumber: number): Promise<void> {
  await getPool().query(`UPDATE tasks SET pr_number = $2 WHERE id = $1`, [
    id,
    prNumber,
  ]);
}

export async function setTaskTrigger(
  id: number,
  triggeredBy: string,
  triggerCommentUrl: string | null,
): Promise<void> {
  await getPool().query(
    `UPDATE tasks SET triggered_by = $2, trigger_comment_url = $3 WHERE id = $1`,
    [id, triggeredBy, triggerCommentUrl],
  );
}

export async function setTaskPrAndState(
  id: number,
  prNumber: number,
  state: TaskState,
): Promise<void> {
  await getPool().query(
    `UPDATE tasks SET pr_number = $2, state = $3, state_reason = NULL WHERE id = $1`,
    [id, prNumber, state],
  );
}

export async function findTasksWaitingOnPr(repoFullName: string): Promise<Task[]> {
  // Only ISSUE implement tasks wait on a manually-opened PR. PR-subject tasks
  // already have their PR (the subject), so they must be excluded — otherwise
  // markPrOpened could stamp an unrelated PR sharing the head branch onto them.
  const res = await getPool().query<Task>(
    `SELECT * FROM tasks
     WHERE repo_full_name = $1
       AND kind = 'implement'
       AND subject_type = 'issue'
       AND branch_name IS NOT NULL
       AND pr_number IS NULL
       AND state = 'awaiting_external'`,
    [repoFullName],
  );
  return res.rows;
}

/** Whether a review task already exists for a PR (used to re-review new commits
 *  even after GitHub drops me from the PR's requested_reviewers). */
export async function hasReviewTask(
  repoFullName: string,
  prNumber: number,
): Promise<boolean> {
  const res = await getPool().query(
    `SELECT 1 FROM tasks
     WHERE repo_full_name = $1
       AND kind = 'review'
       AND subject_type = 'pull_request'
       AND subject_number = $2
     LIMIT 1`,
    [repoFullName, prNumber],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function findOpenPrTask(
  repoFullName: string,
  prNumber: number,
): Promise<Task | undefined> {
  const res = await getPool().query<Task>(
    `SELECT * FROM tasks
     WHERE repo_full_name = $1
       AND (
         pr_number = $2
         OR (subject_type = 'pull_request' AND subject_number = $2)
       )
       AND state::text NOT IN ${TERMINAL_STATE_SQL}
     ORDER BY updated_at DESC
     LIMIT 1`,
    [repoFullName, prNumber],
  );
  return res.rows[0];
}

export async function findTasksTrackingPr(
  repoFullName: string,
  prNumber: number,
): Promise<Task[]> {
  const res = await getPool().query<Task>(
    `SELECT * FROM tasks
     WHERE repo_full_name = $1
       AND (
         (subject_type = 'pull_request' AND subject_number = $2)
         OR pr_number = $2
       )
       AND state::text NOT IN ${TERMINAL_STATE_SQL}`,
    [repoFullName, prNumber],
  );
  return res.rows;
}

export async function findTasksTrackingAnyPr(repoFullName: string): Promise<Task[]> {
  const res = await getPool().query<Task>(
    `SELECT * FROM tasks
     WHERE repo_full_name = $1
       AND (
         pr_number IS NOT NULL
         OR subject_type = 'pull_request'
       )
       AND state::text NOT IN ${TERMINAL_STATE_SQL}`,
    [repoFullName],
  );
  return res.rows;
}

/**
 * Move a subject's active tasks to a terminal state — e.g. when its PR is
 * merged/closed (Branch lifecycle). Only touches non-terminal rows.
 */
export async function closeSubjectTasks(
  repoFullName: string,
  subjectType: SubjectType,
  subjectNumber: number,
  state: Extract<TaskState, "done" | "cancelled">,
  reason: string | null = null,
): Promise<number> {
  const res = await getPool().query(
    `UPDATE tasks SET state = $4, state_reason = $5
     WHERE repo_full_name = $1 AND subject_type = $2 AND subject_number = $3
       AND state::text NOT IN ${TERMINAL_STATE_SQL}`,
    [repoFullName, subjectType, subjectNumber, state, reason],
  );
  return res.rowCount ?? 0;
}

// ── listings (for the external frontend) ────────────────────────────────────

export interface TaskListItem extends Task {
  run_id: number | null;
  attempt: number | null;
  outcome: RunOutcome | null;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface GcRunCandidate {
  id: number;
  task_id: number;
  finished_at: Date;
}

/**
 * Tasks joined with their latest run, newest first. scope='active' returns only
 * tasks that still need attention (non-terminal); 'all' returns everything.
 */
export async function listTasks(
  scope: "active" | "all",
  limit = 200,
): Promise<TaskListItem[]> {
  const where =
    scope === "active"
      ? `WHERE t.state::text NOT IN ${TERMINAL_STATE_SQL}`
      : ``;
  const res = await getPool().query<TaskListItem>(
    `SELECT t.*,
       r.id AS run_id, r.attempt, r.outcome, r.started_at, r.finished_at
     FROM tasks t
     LEFT JOIN LATERAL (
       SELECT * FROM task_runs WHERE task_id = t.id ORDER BY attempt DESC LIMIT 1
     ) r ON true
     ${where}
     ORDER BY t.updated_at DESC
     LIMIT $1`,
    [limit],
  );
  return res.rows;
}

// ── task_runs ───────────────────────────────────────────────────────────────

export async function getRun(id: number): Promise<TaskRun | undefined> {
  const res = await getPool().query<TaskRun>(
    `SELECT * FROM task_runs WHERE id = $1`,
    [id],
  );
  return res.rows[0];
}

export async function getLatestRun(
  taskId: number,
): Promise<TaskRun | undefined> {
  const res = await getPool().query<TaskRun>(
    `SELECT * FROM task_runs WHERE task_id = $1 ORDER BY attempt DESC LIMIT 1`,
    [taskId],
  );
  return res.rows[0];
}

/** Run ids whose task/run state says the worker may still need live resources. */
export async function listActiveRunIds(): Promise<number[]> {
  const res = await getPool().query<{ id: string | number }>(
    `SELECT DISTINCT r.id
     FROM task_runs r
     JOIN tasks t ON t.id = r.task_id
     WHERE t.state::text IN ${ACTIVE_STATE_SQL}`,
  );
  return res.rows.map((r) => Number(r.id));
}

/** Latest run id per task. These remain frontend-visible even after finishing. */
export async function listLatestRunIds(): Promise<number[]> {
  const res = await getPool().query<{ id: string | number }>(
    `SELECT DISTINCT ON (task_id) id
     FROM task_runs
     ORDER BY task_id, attempt DESC`,
  );
  return res.rows.map((r) => Number(r.id));
}

/**
 * Finished, non-latest runs whose parent task is no longer in an active state.
 * These are the only run logs/worktrees eligible for garbage collection.
 */
export async function listRetainableFinishedNonLatestRuns(): Promise<
  GcRunCandidate[]
> {
  const res = await getPool().query<{
    id: string | number;
    task_id: string | number;
    finished_at: Date;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (task_id) id
       FROM task_runs
       ORDER BY task_id, attempt DESC
     )
     SELECT r.id, r.task_id, r.finished_at
     FROM task_runs r
     JOIN tasks t ON t.id = r.task_id
     LEFT JOIN latest l ON l.id = r.id
     WHERE r.finished_at IS NOT NULL
       AND l.id IS NULL
       AND t.state::text NOT IN ${ACTIVE_STATE_SQL}
     ORDER BY r.finished_at ASC, r.id ASC`,
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    task_id: Number(r.task_id),
    finished_at: r.finished_at,
  }));
}

export async function listFinishedNonLatestRunsOlderThan(
  cutoff: Date,
): Promise<GcRunCandidate[]> {
  const runs = await listRetainableFinishedNonLatestRuns();
  return runs.filter((run) => run.finished_at < cutoff);
}

export async function markRunStarted(
  id: number,
  containerName: string,
  jsonlPath: string,
): Promise<void> {
  await getPool().query(
    `UPDATE task_runs
     SET started_at = now(), container_name = $2, jsonl_path = $3
     WHERE id = $1`,
    [id, containerName, jsonlPath],
  );
}

export async function finishRun(
  id: number,
  fields: {
    outcome: RunOutcome;
    exitCode: number | null;
    resultMd: string | null;
  },
): Promise<void> {
  await getPool().query(
    `UPDATE task_runs
     SET finished_at = now(), outcome = $2, exit_code = $3, result_md = $4
     WHERE id = $1`,
    [id, fields.outcome, fields.exitCode, fields.resultMd],
  );
}
