import { timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import cors from "@fastify/cors";
import {
  addRun,
  displayStatus,
  enqueueTask,
  getLatestRun,
  getOctokit,
  getTask,
  listTasks,
  loadEnv,
  logger,
  postIssueComment,
  runDirFor,
  setCancelFlag,
  setTaskState,
  taskDirFor,
  TERMINAL_STATES,
  type Task,
  type TaskListItem,
} from "@kotx/shared";
import Docker from "dockerode";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

function eq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Gate the API behind a Bearer token (== API_TOKEN). Returns false (and sends a
 *  response) when the token is missing/wrong or the API is disabled. */
function requireAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  const token = loadEnv().apiToken;
  if (!token) {
    reply.code(503).send({ error: "API disabled: set API_TOKEN to enable it." });
    return false;
  }
  const hdr = req.headers.authorization;
  if (hdr?.startsWith("Bearer ")) {
    if (eq(hdr.slice(7).trim(), token)) return true;
  }
  reply.code(401).send({ error: "authentication required" });
  return false;
}

function githubUrl(repo: string, subjectType: string, subjectNumber: number): string {
  const kind = subjectType === "pull_request" ? "pull" : "issues";
  return `https://github.com/${repo}/${kind}/${subjectNumber}`;
}

function taskDto(t: TaskListItem) {
  return {
    id: t.id,
    repo: t.repo_full_name,
    subjectType: t.subject_type,
    subjectNumber: t.subject_number,
    kind: t.kind,
    role: t.role,
    state: t.state,
    status: displayStatus(t.state),
    branch: t.branch_name,
    triggeredBy: t.triggered_by,
    outcome: t.outcome,
    attempt: t.attempt,
    startedAt: t.started_at,
    finishedAt: t.finished_at,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    githubUrl: githubUrl(t.repo_full_name, t.subject_type, t.subject_number),
    canStart: t.kind === "implement" && t.state === "draft",
    canApprove: t.kind === "review" && t.state === "awaiting_approval",
    canStop: t.state === "queued" || t.state === "running" || t.state === "drafting",
  };
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Read a per-task artifact (TASK.md / REVIEW.md) or null if absent. */
function readTaskArtifact(taskId: number, name: string): Promise<string | null> {
  return readFileOrNull(join(taskDirFor(loadEnv().agentDataDir, taskId), name));
}

/** Read a file from a task's latest run dir (PROMPT.md / codex.jsonl). */
async function readLatestRunArtifact(
  taskId: number,
  name: string,
): Promise<string | null> {
  const run = await getLatestRun(taskId);
  if (!run) return null;
  return readFileOrNull(join(runDirFor(loadEnv().agentDataDir, run.id), name));
}

let docker: Docker | undefined;
function getDocker(): Docker {
  if (!docker) docker = new Docker();
  return docker;
}

export function registerApi(app: FastifyInstance): void {
  const origin = loadEnv().corsOrigin;
  app.register(cors, { origin: origin ?? false, methods: ["GET", "POST", "PUT"] });

  // Tasks where I'm assignee or my review is requested, with status.
  app.get("/api/tasks", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const scope =
      (req.query as { scope?: string }).scope === "all" ? "all" : "active";
    const rows = await listTasks(scope);
    return rows.map(taskDto);
  });

  app.get("/api/tasks/:id", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseId(req, reply);
    if (id === null) return;
    const rows = await listTasks("all", 1000);
    // task ids are BIGINT → pg returns them as strings; coerce before comparing.
    const row = rows.find((r) => Number(r.id) === id);
    if (!row) return reply.code(404).send({ error: "no such task" });
    return taskDto(row);
  });

  app.get("/api/tasks/:id/task", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseId(req, reply);
    if (id === null) return;
    const text = await readTaskArtifact(id, "TASK.md");
    if (text === null) return reply.code(404).send({ error: "no TASK.md" });
    return reply.type("text/markdown").send(text);
  });

  // Edit the brief before starting the implementation.
  app.put("/api/tasks/:id/task", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseId(req, reply);
    if (id === null) return;
    const task = await getTask(id);
    if (!task) return reply.code(404).send({ error: "no such task" });
    if (task.kind !== "implement" || task.state !== "draft")
      return reply.code(409).send({ error: `cannot edit brief in state ${task.state}` });
    const body = bodyText(req);
    if (body === null) return reply.code(400).send({ error: "empty body" });
    const dir = taskDirFor(loadEnv().agentDataDir, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "TASK.md"), body, "utf8");
    return { ok: true };
  });

  app.get("/api/tasks/:id/review", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseId(req, reply);
    if (id === null) return;
    const text = await readTaskArtifact(id, "REVIEW.md");
    if (text === null) return reply.code(404).send({ error: "no REVIEW.md" });
    return reply.type("text/markdown").send(text);
  });

  // Edit the review before approving/posting it.
  app.put("/api/tasks/:id/review", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseId(req, reply);
    if (id === null) return;
    const task = await getTask(id);
    if (!task) return reply.code(404).send({ error: "no such task" });
    if (task.kind !== "review" || task.state !== "awaiting_approval")
      return reply.code(409).send({ error: `cannot edit review in state ${task.state}` });
    const body = bodyText(req);
    if (body === null) return reply.code(400).send({ error: "empty body" });
    const dir = taskDirFor(loadEnv().agentDataDir, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "REVIEW.md"), body, "utf8");
    return { ok: true };
  });

  // The exact prompt piped into Codex on the latest run (for inspection/debug).
  app.get("/api/tasks/:id/prompt", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseId(req, reply);
    if (id === null) return;
    const text = await readLatestRunArtifact(id, "PROMPT.md");
    if (text === null) return reply.code(404).send({ error: "no PROMPT.md yet" });
    return reply.type("text/markdown").send(text);
  });

  // The raw Codex transcript (JSONL) for the latest run — useful for failures.
  app.get("/api/tasks/:id/log", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseId(req, reply);
    if (id === null) return;
    const text = await readLatestRunArtifact(id, "codex.jsonl");
    if (text === null) return reply.code(404).send({ error: "no log yet" });
    return reply.type("application/x-ndjson").send(text);
  });

  // Branch 1: start the implementation for a reviewed draft.
  app.post("/api/tasks/:id/start", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseId(req, reply);
    if (id === null) return;
    const task = await getTask(id);
    if (!task) return reply.code(404).send({ error: "no such task" });
    if (task.kind !== "implement" || task.state !== "draft")
      return reply.code(409).send({ error: `cannot start task in state ${task.state}` });
    const run = await addRun(id, loadEnv().agentDataDir);
    await setTaskState(id, "queued");
    await enqueueRun(task, run.id, "execute");
    logger.info({ taskId: id }, "task started from API");
    return { ok: true };
  });

  // Branch 3: approve the review → post REVIEW.md to the PR.
  app.post("/api/tasks/:id/approve", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseId(req, reply);
    if (id === null) return;
    const task = await getTask(id);
    if (!task) return reply.code(404).send({ error: "no such task" });
    if (task.kind !== "review" || task.state !== "awaiting_approval")
      return reply.code(409).send({ error: `cannot approve task in state ${task.state}` });
    const review = await readTaskArtifact(id, "REVIEW.md");
    if (review === null) return reply.code(404).send({ error: "no REVIEW.md to post" });
    await postIssueComment(getOctokit(), task.repo_full_name, task.subject_number, review);
    await setTaskState(id, "done");
    logger.info({ taskId: id }, "review approved and posted");
    return { ok: true };
  });

  app.post("/api/tasks/:id/stop", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseId(req, reply);
    if (id === null) return;
    const task = await getTask(id);
    if (!task) return reply.code(404).send({ error: "no such task" });
    if (TERMINAL_STATES.has(task.state))
      return reply.code(409).send({ error: `task already ${task.state}` });
    await setCancelFlag(id);
    // pre-execution states have no container to kill — terminate directly.
    if (task.state === "queued" || task.state === "draft" || task.state === "drafting")
      await setTaskState(id, "cancelled");
    logger.info({ taskId: id }, "stop requested from API");
    return { ok: true };
  });

  // Dismiss a task (any kind) from the active list. Also signals cancel so a
  // running container / pending job is stopped. A run that finishes after this
  // may briefly land as "cancelled" — still terminal, still out of "active".
  app.post("/api/tasks/:id/discard", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseId(req, reply);
    if (id === null) return;
    const task = await getTask(id);
    if (!task) return reply.code(404).send({ error: "no such task" });
    if (TERMINAL_STATES.has(task.state))
      return reply.code(409).send({ error: `task already ${task.state}` });
    await setCancelFlag(id);
    await setTaskState(id, "discarded");
    logger.info({ taskId: id }, "task discarded from API");
    return { ok: true };
  });

  // Live view of the running codex-runner containers.
  app.get("/api/containers", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    try {
      const list = await getDocker().listContainers({ all: false });
      return list
        .filter((c) => c.Names.some((n) => n.includes("codex-task-")))
        .map((c) => {
          const name = c.Names[0]?.replace(/^\//, "") ?? "";
          const m = /codex-task-(\d+)/.exec(name);
          return {
            id: c.Id.slice(0, 12),
            name,
            runId: m ? Number(m[1]) : null,
            image: c.Image,
            state: c.State,
            status: c.Status,
            createdAt: c.Created,
          };
        });
    } catch (err) {
      logger.error({ err }, "docker ps failed");
      return reply.code(503).send({ error: "docker unavailable" });
    }
  });
}

function parseId(req: FastifyRequest, reply: FastifyReply): number | null {
  const id = Number((req.params as { id: string }).id);
  if (!Number.isInteger(id) || id <= 0) {
    reply.code(400).send({ error: "bad task id" });
    return null;
  }
  return id;
}

/**
 * Extract a non-empty markdown body from a PUT. Accepts:
 *  - text/markdown or text/plain → a raw string;
 *  - application/json → a raw Buffer (the global HMAC parser), holding either a
 *    JSON string, a `{ "content": "…" }` object, or just raw markdown.
 */
function bodyText(req: FastifyRequest): string | null {
  const b = req.body;
  let text: string | undefined;
  if (typeof b === "string") {
    text = b;
  } else if (Buffer.isBuffer(b)) {
    const raw = b.toString("utf8");
    try {
      const parsed = JSON.parse(raw);
      text = typeof parsed === "string" ? parsed : parsed?.content;
    } catch {
      text = raw; // not JSON — treat the buffer as the markdown itself
    }
  } else if (b && typeof b === "object") {
    text = (b as { content?: string }).content;
  }
  return typeof text === "string" && text.trim() !== "" ? text : null;
}

async function enqueueRun(
  task: Task,
  runId: number,
  phase: "draft" | "execute",
): Promise<void> {
  await enqueueTask({
    taskId: task.id,
    taskRunId: runId,
    kind: task.kind,
    phase,
    repoFullName: task.repo_full_name,
    subject: { type: task.subject_type, number: task.subject_number },
  });
}
