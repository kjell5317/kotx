import { join } from "node:path";
import pg from "pg";
import { loadEnv } from "./config.js";
import type {
  RunOutcome,
  SubjectType,
  Task,
  TaskKind,
  TaskRun,
  TaskState,
} from "./types.js";

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
       AND state IN ('queued','running','awaiting_approval')`,
    [repoFullName, subjectType, subjectNumber],
  );
  return res.rows[0];
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

/**
 * Creates a task + its first run atomically, deriving the run's worktree path
 * from the generated run id. Returns undefined if an active task already exists
 * for the subject (unique-index race) — caller treats it as "already running".
 */
export async function createTaskWithRun(input: {
  repoFullName: string;
  subjectType: SubjectType;
  subjectNumber: number;
  kind: TaskKind;
  branchName: string | null;
  triggeredBy: string;
  dataDir: string;
}): Promise<{ task: Task; run: TaskRun } | undefined> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    let task: Task;
    try {
      const t = await client.query<Task>(
        `INSERT INTO tasks
           (repo_full_name, subject_type, subject_number, kind, state, branch_name, triggered_by)
         VALUES ($1,$2,$3,$4,'queued',$5,$6)
         RETURNING *`,
        [
          input.repoFullName,
          input.subjectType,
          input.subjectNumber,
          input.kind,
          input.branchName,
          input.triggeredBy,
        ],
      );
      task = t.rows[0]!;
    } catch (err) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(err)) return undefined;
      throw err;
    }
    // insert with placeholder path, then set it from the generated run id
    const r = await client.query<TaskRun>(
      `INSERT INTO task_runs (task_id, attempt, worktree_path)
       VALUES ($1, 1, '') RETURNING *`,
      [task.id],
    );
    let run = r.rows[0]!;
    const path = worktreePathFor(input.dataDir, run.id);
    const u = await client.query<TaskRun>(
      `UPDATE task_runs SET worktree_path = $2 WHERE id = $1 RETURNING *`,
      [run.id, path],
    );
    run = u.rows[0]!;
    await client.query("COMMIT");
    return { task, run };
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
): Promise<void> {
  await getPool().query(`UPDATE tasks SET state = $2 WHERE id = $1`, [
    id,
    state,
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
