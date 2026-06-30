import { timingSafeEqual } from "node:crypto";
import { open, readFile, writeFile, mkdir } from "node:fs/promises";
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
  const inExternal = t.state === "awaiting_external";
  const hasKnownPr = t.pr_number !== null || t.subject_type === "pull_request";
  return {
    id: t.id,
    repo: t.repo_full_name,
    subjectType: t.subject_type,
    subjectNumber: t.subject_number,
    title: t.subject_title,
    kind: t.kind,
    role: t.role,
    state: t.state,
    status: inExternal
      ? hasKnownPr
        ? "in review"
        : "waiting on PR"
      : displayStatus(t.state),
    stateReason: t.state_reason,
    branch: t.branch_name,
    prNumber: t.pr_number,
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
    // any non-terminal task can be dismissed (e.g. one stuck "in review")
    canDiscard: !TERMINAL_STATES.has(t.state),
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

const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 1000;
const LOG_READ_CHUNK_BYTES = 64 * 1024;

interface LogQuery {
  limit: number;
  before?: number;
}

interface LogLine {
  startOffset: number;
  endOffset: number;
  bytes: Buffer;
}

interface LogEntry {
  offset: number;
  record?: unknown;
  raw?: string;
  parseError?: string;
}

interface LogPage {
  runId: number;
  entries: LogEntry[];
  page: {
    limit: number;
    count: number;
    startOffset: number;
    endOffset: number;
    sizeBytes: number;
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
    nextBefore: number | null;
  };
}

class LogQueryError extends Error {}

async function readLatestRunLogPage(
  taskId: number,
  query: LogQuery,
): Promise<LogPage | null> {
  const run = await getLatestRun(taskId);
  if (!run) return null;
  const path = join(runDirFor(loadEnv().agentDataDir, run.id), "codex.jsonl");
  try {
    return await readLogFilePage(run.id, path, query);
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

export async function readLogFilePage(
  runId: number,
  path: string,
  query: LogQuery,
): Promise<LogPage> {
  const fh = await open(path, "r");
  try {
    const stats = await fh.stat();
    const sizeBytes = stats.size;
    const endOffset = query.before ?? sizeBytes;
    if (endOffset > sizeBytes) {
      throw new LogQueryError(`before must be <= log size (${sizeBytes})`);
    }
    if (
      query.before !== undefined &&
      endOffset !== 0 &&
      endOffset !== sizeBytes &&
      !(await isLineBoundary(fh, endOffset))
    ) {
      throw new LogQueryError("before must be a line boundary cursor");
    }
    if (endOffset === 0 || query.limit === 0) {
      return {
        runId,
        entries: [],
        page: {
          limit: query.limit,
          count: 0,
          startOffset: 0,
          endOffset,
          sizeBytes,
          hasMoreBefore: false,
          hasMoreAfter: endOffset < sizeBytes,
          nextBefore: null,
        },
      };
    }

    let start = endOffset;
    let buffer = Buffer.alloc(0);
    let lines: LogLine[] = [];
    while (start > 0) {
      const chunkStart = Math.max(0, start - LOG_READ_CHUNK_BYTES);
      const chunk = Buffer.alloc(start - chunkStart);
      await fh.read(chunk, 0, chunk.length, chunkStart);
      buffer = Buffer.concat([chunk, buffer]);
      start = chunkStart;
      lines = extractCompleteLines(buffer, start, endOffset);
      if (lines.length >= query.limit) break;
    }

    const pageLines = lines.slice(-query.limit);
    const startOffset = pageLines[0]?.startOffset ?? endOffset;
    return {
      runId,
      entries: pageLines.map(logLineToEntry),
      page: {
        limit: query.limit,
        count: pageLines.length,
        startOffset,
        endOffset,
        sizeBytes,
        hasMoreBefore: startOffset > 0,
        hasMoreAfter: endOffset < sizeBytes,
        nextBefore: startOffset > 0 ? startOffset : null,
      },
    };
  } finally {
    await fh.close();
  }
}

async function isLineBoundary(
  fh: Awaited<ReturnType<typeof open>>,
  offset: number,
): Promise<boolean> {
  const byte = Buffer.alloc(1);
  await fh.read(byte, 0, 1, offset - 1);
  return byte[0] === 10;
}

function extractCompleteLines(
  bytes: Buffer,
  bufferStartOffset: number,
  endOffset: number,
): LogLine[] {
  const lines: LogLine[] = [];
  let lineStart = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 10) continue;
    if (i > lineStart) {
      lines.push({
        startOffset: bufferStartOffset + lineStart,
        endOffset: bufferStartOffset + i,
        bytes: bytes.subarray(lineStart, i),
      });
    }
    lineStart = i + 1;
  }
  if (lineStart < bytes.length) {
    lines.push({
      startOffset: bufferStartOffset + lineStart,
      endOffset,
      bytes: bytes.subarray(lineStart),
    });
  }
  return bufferStartOffset === 0 ? lines : lines.slice(1);
}

function logLineToEntry(line: LogLine): LogEntry {
  const raw = line.bytes.toString("utf8");
  try {
    return { offset: line.startOffset, record: JSON.parse(raw) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid JSON";
    return { offset: line.startOffset, raw, parseError: message };
  }
}

function parseLogQuery(
  req: FastifyRequest,
  reply: FastifyReply,
): LogQuery | null {
  const query = req.query as Record<string, unknown>;
  const limit = parseOptionalPositiveInteger(
    query.limit,
    "limit",
    DEFAULT_LOG_LIMIT,
    MAX_LOG_LIMIT,
  );
  if (typeof limit === "string") {
    reply.code(400).send({ error: limit });
    return null;
  }

  const before = parseOptionalNonNegativeInteger(query.before, "before");
  if (typeof before === "string") {
    reply.code(400).send({ error: before });
    return null;
  }

  return before === undefined ? { limit } : { limit, before };
}

function parseOptionalPositiveInteger(
  value: unknown,
  name: string,
  fallback: number,
  max: number,
): number | string {
  if (value === undefined) return fallback;
  const parsed = parseSingleInteger(value, name);
  if (typeof parsed === "string") return parsed;
  if (parsed <= 0) return `${name} must be greater than 0`;
  if (parsed > max) return `${name} must be <= ${max}`;
  return parsed;
}

function parseOptionalNonNegativeInteger(
  value: unknown,
  name: string,
): number | string | undefined {
  if (value === undefined) return undefined;
  const parsed = parseSingleInteger(value, name);
  if (typeof parsed === "string") return parsed;
  if (parsed < 0) return `${name} must be >= 0`;
  return parsed;
}

function parseSingleInteger(value: unknown, name: string): number | string {
  if (Array.isArray(value)) return `${name} must be provided once`;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return `${name} must be an integer`;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return `${name} is too large`;
  return parsed;
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

  // A bounded JSON view of the latest Codex transcript, newest page by default.
  app.get("/api/tasks/:id/log", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseId(req, reply);
    if (id === null) return;
    const query = parseLogQuery(req, reply);
    if (query === null) return;
    try {
      const page = await readLatestRunLogPage(id, query);
      if (page === null) return reply.code(404).send({ error: "no log yet" });
      return page;
    } catch (err) {
      if (err instanceof LogQueryError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
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

  // Branch 3: approve the review → post REVIEW.md to the PR, then wait for the
  // PR lifecycle to finish.
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
    await setTaskState(id, "awaiting_external");
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
      await setTaskState(id, "cancelled", "stopped from the API");
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
    await setTaskState(id, "cancelled", "discarded from the API");
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
