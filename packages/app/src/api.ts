import { timingSafeEqual } from "node:crypto";
import { open, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import cors from "@fastify/cors";
import {
  addRun,
  approvePullRequestReview,
  clearNotification,
  displayStatus,
  enqueueTask,
  getEnabledRepo,
  getLatestRun,
  getOctokit,
  getTask,
  loadRepos,
  listTasks,
  loadEnv,
  logger,
  mergePullRequest,
  openPullRequest,
  postIssueComment,
  runDirFor,
  setCancelFlag,
  setTaskPrAndState,
  setTaskState,
  splitRepo,
  taskDirFor,
  taskNotifyTag,
  TERMINAL_STATES,
  updateBranchFromBase,
  type RepoConfig,
  type Task,
  type TaskListItem,
} from "@kotx/shared";
import Docker from "dockerode";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { NormalizedSubject } from "./extract.js";
import {
  maybeResolveConflict,
  startDraft,
  startReview,
  type IngestResult,
} from "./pipeline.js";

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
  const trackedPr = trackedPrNumber(t);
  const hasKnownPr = trackedPr !== null;
  const mergeProposal =
    t.kind === "implement" &&
    t.state === "awaiting_approval" &&
    trackedPr !== null;
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
    trackedPrNumber: trackedPr,
    triggeredBy: t.triggered_by,
    outcome: t.outcome,
    attempt: t.attempt,
    startedAt: t.started_at,
    finishedAt: t.finished_at,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    githubUrl: githubUrl(t.repo_full_name, t.subject_type, t.subject_number),
    canStart: t.kind === "implement" && t.state === "draft",
    // review → submit an approving PR review; implement (issue-origin) → open the proposed PR.
    canApprove:
      t.state === "awaiting_approval" &&
      (t.kind === "review" || t.kind === "implement"),
    canMerge: mergeProposal,
    // review tasks can also post REVIEW.md as a plain PR comment instead.
    canComment: t.kind === "review" && t.state === "awaiting_approval",
    // what approving this task does, so the UI can label the button/proposal.
    proposes:
      t.state === "awaiting_approval"
        ? t.kind === "review"
          ? "review"
          : t.kind === "implement"
            ? mergeProposal
              ? "merge"
              : "pr"
            : null
        : null,
    // any non-terminal task can be dismissed (e.g. one stuck "in review")
    canDiscard: !TERMINAL_STATES.has(t.state),
  };
}

function trackedPrNumber(
  task: Pick<Task, "pr_number" | "subject_type" | "subject_number">,
): number | null {
  return task.pr_number ??
    (task.subject_type === "pull_request" ? task.subject_number : null);
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

async function requirePendingReview(
  id: number,
  reply: FastifyReply,
  existingTask?: Task,
): Promise<{ task: Task; review: string } | null> {
  const task = existingTask ?? (await getTask(id));
  if (!task) {
    reply.code(404).send({ error: "no such task" });
    return null;
  }
  if (task.kind !== "review" || task.state !== "awaiting_approval") {
    reply.code(409).send({ error: `cannot finalize review in state ${task.state}` });
    return null;
  }
  const review = await readTaskArtifact(id, "REVIEW.md");
  if (review === null) {
    reply.code(404).send({ error: "no REVIEW.md" });
    return null;
  }
  return { task, review };
}

async function requirePendingMerge(
  id: number,
  reply: FastifyReply,
  existingTask?: Task,
): Promise<{ task: Task; prNumber: number } | null> {
  const task = existingTask ?? (await getTask(id));
  if (!task) {
    reply.code(404).send({ error: "no such task" });
    return null;
  }
  const prNumber = trackedPrNumber(task);
  if (
    task.kind !== "implement" ||
    task.state !== "awaiting_approval" ||
    prNumber === null
  ) {
    reply
      .code(409)
      .send({ error: `cannot merge from state ${task.state}` });
    return null;
  }
  if ((await readTaskArtifact(id, "MERGE_APPROVAL.md")) === null) {
    reply.code(409).send({ error: "no pending merge proposal" });
    return null;
  }
  return { task, prNumber };
}

function isGithubMergeBlocked(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const status = (err as { status?: number }).status;
  return status === 404 || status === 405 || status === 409 || status === 422;
}

function githubMergeErrorMessage(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const status = (err as { status?: number }).status;
    if (status === 404) return "pull request was not found";
    if (status === 405 || status === 409 || status === 422)
      return "pull request is not mergeable";
  }
  return "pull request merge failed";
}

async function confirmMerge(
  id: number,
  reply: FastifyReply,
  existingTask?: Task,
) {
  const pending = await requirePendingMerge(id, reply, existingTask);
  if (!pending) return;
  const repo = getEnabledRepo(pending.task.repo_full_name);
  if (!repo) return reply.code(409).send({ error: "repository is not enabled" });
  try {
    const merged = await mergePullRequest(
      getOctokit(),
      pending.task.repo_full_name,
      pending.prNumber,
      repo.merge_method,
    );
    await setTaskState(id, "done", `PR #${pending.prNumber} merged`);
    await clearNotification(taskNotifyTag(id));
    logger.info(
      {
        taskId: id,
        prNumber: pending.prNumber,
        mergeMethod: repo.merge_method,
        sha: merged.sha,
      },
      "pull request merged from API",
    );
    return {
      ok: true,
      prNumber: pending.prNumber,
      mergeMethod: repo.merge_method,
      sha: merged.sha,
      message: merged.message,
    };
  } catch (err) {
    if (isGithubMergeBlocked(err)) {
      return reply.code(409).send({ error: githubMergeErrorMessage(err) });
    }
    logger.error(
      { err, taskId: id, prNumber: pending.prNumber },
      "pull request merge failed",
    );
    return reply.code(500).send({ error: "github merge failed" });
  }
}

const DEFAULT_LOG_LIMIT = 50;
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

type ManualRunType = "implement" | "review" | "resolve";

interface ExistingManualRunRequest {
  mode: "existing";
  type: ManualRunType;
  number: number;
  // optional "owner/name" — required only when more than one repo is enabled.
  repo?: string;
}

interface CreateIssueManualRunRequest {
  mode: "create_issue";
  title: string;
  body?: string;
  // optional "owner/name" or friendly alias — required only when more than one repo is enabled.
  repo?: string;
}

type ManualRunRequest = ExistingManualRunRequest | CreateIssueManualRunRequest;

function parseManualRunRequest(
  req: FastifyRequest,
  reply: FastifyReply,
): ManualRunRequest | null {
  const parsed = parseJsonObjectBody(req.body);
  if (typeof parsed === "string") {
    reply.code(400).send({ error: parsed });
    return null;
  }

  const unexpected = Object.keys(parsed).filter(
    (key) =>
      key !== "type" &&
      key !== "number" &&
      key !== "repo" &&
      key !== "title" &&
      key !== "body",
  );
  if (unexpected.length > 0) {
    reply.code(400).send({ error: `unexpected field: ${unexpected[0]}` });
    return null;
  }

  const { type, number, repo, title, body } = parsed;
  if (
    type !== undefined &&
    type !== "implement" &&
    type !== "review" &&
    type !== "resolve"
  ) {
    reply
      .code(400)
      .send({ error: 'type must be "implement", "review", or "resolve"' });
    return null;
  }
  if (repo !== undefined && (typeof repo !== "string" || repo.trim() === "")) {
    reply.code(400).send({ error: 'repo must be a non-empty "owner/name" string' });
    return null;
  }

  if (number === undefined) {
    if (typeof title !== "string" || title.trim() === "") {
      reply.code(400).send({ error: "title must be a non-empty string" });
      return null;
    }
    if (body !== undefined && typeof body !== "string") {
      reply.code(400).send({ error: "body must be a string" });
      return null;
    }
    return {
      mode: "create_issue",
      title: title.trim(),
      ...(body === undefined ? {} : { body }),
      ...(repo === undefined ? {} : { repo }),
    };
  }

  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0
  ) {
    reply.code(400).send({ error: "number must be a positive integer" });
    return null;
  }
  if (type === undefined) {
    reply
      .code(400)
      .send({ error: 'type must be "implement", "review", or "resolve"' });
    return null;
  }
  return { mode: "existing", type, number, ...(repo === undefined ? {} : { repo }) };
}

function parseJsonObjectBody(body: unknown): Record<string, unknown> | string {
  let obj: unknown;
  if (Buffer.isBuffer(body)) {
    try {
      obj = JSON.parse(body.toString("utf8"));
    } catch {
      return "invalid json";
    }
  } else if (typeof body === "string") {
    try {
      obj = JSON.parse(body);
    } catch {
      return "invalid json";
    }
  } else {
    obj = body;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return "body must be a JSON object";
  }
  return obj as Record<string, unknown>;
}

const MANUAL_RUN_REPO_ALIASES = new Map<string, string>([
  ["social ai", "TUM-Social-AI/AflaConnect"],
  ["csee", "askLio/CSEE-strategic-negotiation-agent"],
]);

function normalizeManualRunRepoInput(requested: string): string {
  const trimmed = requested.trim().replace(/\/+$/g, "");
  const aliasKey = trimmed.replace(/\s+/g, " ").toLowerCase();
  const alias = MANUAL_RUN_REPO_ALIASES.get(aliasKey);
  if (alias) return alias;

  const parts = trimmed.split("/");
  if (parts.length !== 2) return trimmed;
  return `${parts[0]!.trim()}/${parts[1]!.trim()}`;
}

function getManualRunRepo(
  reply: FastifyReply,
  requested?: string,
): RepoConfig | null {
  const enabled = [...loadRepos().values()].filter((repo) => repo.enabled);
  if (enabled.length === 0) {
    reply.code(409).send({ error: "no enabled repository configured" });
    return null;
  }

  // Explicit repo: must be one of the enabled allowlist entries.
  if (requested !== undefined) {
    const normalized = normalizeManualRunRepoInput(requested);
    const repo = getEnabledRepo(normalized);
    if (!repo) {
      reply.code(409).send({
        error: `repo "${requested}" is not an enabled repository`,
        repos: enabled.map((r) => r.full_name),
      });
      return null;
    }
    return repo;
  }

  // No repo given: only unambiguous when a single repo is enabled.
  if (enabled.length > 1) {
    reply.code(409).send({
      error: "multiple repositories enabled — specify \"repo\": \"owner/name\"",
      repos: enabled.map((repo) => repo.full_name),
    });
    return null;
  }
  const repo = getEnabledRepo(enabled[0]!.full_name);
  if (!repo) {
    reply.code(409).send({ error: "repository is not enabled" });
    return null;
  }
  return repo;
}

function logins(
  arr: Array<{ login?: string | null } | null> | null | undefined,
): string[] {
  return (arr ?? [])
    .map((item) => item?.login)
    .filter((login): login is string => !!login);
}

function normalizeIssue(issue: {
  number: number;
  state?: string;
  assignees?: Array<{ login?: string | null } | null> | null;
  title?: string | null;
  body?: string | null;
}): NormalizedSubject {
  return {
    type: "issue",
    number: issue.number,
    state: issue.state === "closed" ? "closed" : "open",
    assignees: logins(issue.assignees),
    requestedReviewers: [],
    title: issue.title ?? "",
    body: issue.body ?? "",
  };
}

function normalizePull(pr: {
  number: number;
  state?: string;
  assignees?: Array<{ login?: string | null } | null> | null;
  requested_reviewers?: Array<{ login?: string | null } | null> | null;
  title?: string | null;
  body?: string | null;
  head?: {
    ref?: string | null;
    repo?: { full_name?: string | null } | null;
  } | null;
  base?: { ref?: string | null } | null;
  merged?: boolean | null;
}): NormalizedSubject {
  return {
    type: "pull_request",
    number: pr.number,
    state: pr.state === "closed" ? "closed" : "open",
    assignees: logins(pr.assignees),
    requestedReviewers: logins(pr.requested_reviewers),
    title: pr.title ?? "",
    body: pr.body ?? "",
    headRef: pr.head?.ref ?? undefined,
    headRepoFullName: pr.head?.repo?.full_name ?? undefined,
    baseRef: pr.base?.ref ?? undefined,
    merged: !!pr.merged,
  };
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { status?: number }).status === 404
  );
}

async function fetchGithubSubject(
  repo: RepoConfig,
  number: number,
): Promise<NormalizedSubject | null> {
  const [owner, name] = splitRepo(repo.full_name);
  const octokit = getOctokit();
  try {
    const { data: issue } = await octokit.issues.get({
      owner,
      repo: name,
      issue_number: number,
    });
    if (!issue.pull_request) return normalizeIssue(issue);
    const { data: pr } = await octokit.pulls.get({
      owner,
      repo: name,
      pull_number: number,
    });
    return normalizePull(pr);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function createIssue(
  repo: RepoConfig,
  input: CreateIssueManualRunRequest,
): Promise<{ number: number; htmlUrl: string }> {
  const [owner, name] = splitRepo(repo.full_name);
  const octokit = getOctokit();
  const { data: issue } = await octokit.issues.create({
    owner,
    repo: name,
    title: input.title,
    ...(input.body === undefined ? {} : { body: input.body }),
  });
  return { number: issue.number, htmlUrl: issue.html_url };
}

async function assignIssue(
  repo: RepoConfig,
  issueNumber: number,
): Promise<void> {
  const [owner, name] = splitRepo(repo.full_name);
  const octokit = getOctokit();
  await octokit.issues.addAssignees({
    owner,
    repo: name,
    issue_number: issueNumber,
    assignees: [repo.assignee_login],
  });
}

function ignoredStatus(reason: string): number {
  return reason === "repo-not-enabled" ? 404 : 409;
}

function sendManualRunResult(
  reply: FastifyReply,
  result: IngestResult,
  extra: Record<string, unknown> = {},
) {
  if (result.status === "enqueued")
    return reply.code(202).send({ ...result, ...extra });
  if (result.status === "handled")
    return reply.code(200).send({ ...result, ...extra });
  return reply
    .code(ignoredStatus(result.reason))
    .send({ error: result.reason, ...result, ...extra });
}

let docker: Docker | undefined;
function getDocker(): Docker {
  if (!docker) docker = new Docker();
  return docker;
}

export function registerApi(app: FastifyInstance): void {
  const origin = loadEnv().corsOrigin;
  app.register(cors, { origin: origin ?? false, methods: ["GET", "POST", "PUT"] });

  // Manually enqueue a run for the configured repo, bypassing role gates while
  // still requiring the requested action to fit the GitHub subject. Without a
  // number, create and assign an issue so the normal assignment path drafts it.
  app.post("/api/runs", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const input = parseManualRunRequest(req, reply);
    if (!input) return;
    const repo = getManualRunRepo(reply, input.repo);
    if (!repo) return;

    if (input.mode === "create_issue") {
      let issue: { number: number; htmlUrl: string };
      try {
        issue = await createIssue(repo, input);
      } catch (err) {
        logger.error(
          { err, repo: repo.full_name },
          "manual run issue create failed",
        );
        return reply.code(500).send({ error: "github issue create failed" });
      }
      try {
        await assignIssue(repo, issue.number);
      } catch (err) {
        logger.error(
          {
            err,
            repo: repo.full_name,
            issueNumber: issue.number,
            assignee: repo.assignee_login,
          },
          "manual run issue assignment failed",
        );
        return reply.code(500).send({ error: "github issue assignment failed" });
      }
      return reply.code(201).send({
        status: "created",
        repo: repo.full_name,
        issueNumber: issue.number,
        issueUrl: issue.htmlUrl,
        assignee: repo.assignee_login,
      });
    }

    let subject: NormalizedSubject | null;
    try {
      subject = await fetchGithubSubject(repo, input.number);
    } catch (err) {
      logger.error(
        { err, repo: repo.full_name, number: input.number },
        "manual run subject fetch failed",
      );
      return reply.code(500).send({ error: "github lookup failed" });
    }
    if (!subject) return reply.code(404).send({ error: "no such issue or pull request" });

    if (input.type === "implement") {
      return sendManualRunResult(
        reply,
        await startDraft(repo, subject, "api", null),
      );
    }

    if (subject.type !== "pull_request") {
      return reply.code(409).send({
        error: `${input.type} requires an open pull request`,
        status: "ignored",
        reason: "not-pull-request",
      });
    }
    if (subject.state !== "open") {
      return reply.code(409).send({
        error: `${input.type} requires an open pull request`,
        status: "ignored",
        reason: "subject-closed",
      });
    }

    if (input.type === "review") {
      const result = await startReview(repo, subject, "api");
      // Surface who the PR is assigned to so the caller knows who owns it.
      return sendManualRunResult(reply, result, {
        assignees: subject.assignees,
      });
    }
    const result = await maybeResolveConflict(repo, subject, "api");
    return sendManualRunResult(reply, result);
  });

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
    const body = bodyText(req, { allowEmpty: true });
    if (body === null) return reply.code(400).send({ error: "empty body" });
    const dir = taskDirFor(loadEnv().agentDataDir, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "REVIEW.md"), body, "utf8");
    return { ok: true };
  });

  // Branch 1 (issue-origin): the proposed PR title + description, awaiting approval.
  app.get("/api/tasks/:id/pr", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseId(req, reply);
    if (id === null) return;
    const [title, body] = await Promise.all([
      readTaskArtifact(id, "PR_TITLE.md"),
      readTaskArtifact(id, "PR_BODY.md"),
    ]);
    if (title === null && body === null)
      return reply.code(404).send({ error: "no PR proposal" });
    return { title: title?.trim() ?? null, body };
  });

  // Edit the proposed PR title/description before approving/opening it.
  app.put("/api/tasks/:id/pr", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseId(req, reply);
    if (id === null) return;
    const task = await getTask(id);
    if (!task) return reply.code(404).send({ error: "no such task" });
    if (
      task.kind !== "implement" ||
      task.state !== "awaiting_approval" ||
      trackedPrNumber(task) !== null
    )
      return reply.code(409).send({ error: `cannot edit PR proposal in state ${task.state}` });
    const proposal = parsePrProposal(req);
    if (!proposal || (proposal.title === undefined && proposal.body === undefined))
      return reply.code(400).send({ error: "provide title and/or body" });
    if (proposal.title !== undefined && proposal.title.trim() === "")
      return reply.code(400).send({ error: "title cannot be empty" });
    if (proposal.body !== undefined && proposal.body.trim() === "")
      return reply.code(400).send({ error: "body cannot be empty" });
    const dir = taskDirFor(loadEnv().agentDataDir, id);
    await mkdir(dir, { recursive: true });
    if (proposal.title !== undefined)
      await writeFile(join(dir, "PR_TITLE.md"), proposal.title.trim(), "utf8");
    if (proposal.body !== undefined)
      await writeFile(join(dir, "PR_BODY.md"), proposal.body, "utf8");
    return { ok: true };
  });

  app.get("/api/tasks/:id/merge", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseId(req, reply);
    if (id === null) return;
    const text = await readTaskArtifact(id, "MERGE_APPROVAL.md");
    if (text === null)
      return reply.code(404).send({ error: "no merge proposal" });
    return reply.type("text/markdown").send(text);
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
    // The "Start implementation" prompt is done with — dismiss its notification.
    await clearNotification(taskNotifyTag(id));
    logger.info({ taskId: id }, "task started from API");
    return { ok: true };
  });

  // Branch 3: post REVIEW.md as a plain PR comment instead of submitting a review.
  app.post("/api/tasks/:id/comment", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseId(req, reply);
    if (id === null) return;
    const pending = await requirePendingReview(id, reply);
    if (!pending) return;
    if (pending.review.trim() === "")
      return reply.code(400).send({ error: "REVIEW.md cannot be empty when posting a comment" });
    await postIssueComment(
      getOctokit(),
      pending.task.repo_full_name,
      pending.task.subject_number,
      pending.review,
    );
    // The review is delivered — ownership passes to the PR author. If they push
    // new commits the poller/webhook starts a fresh review task, so this run is
    // done rather than lingering in awaiting_external until the PR merges.
    await setTaskState(id, "done", "review posted as comment");
    await clearNotification(taskNotifyTag(id));
    logger.info({ taskId: id }, "review posted as comment");
    return { ok: true };
  });

  // Confirm a merge proposal created from an approving PR review.
  app.post("/api/tasks/:id/merge", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseId(req, reply);
    if (id === null) return;
    return confirmMerge(id, reply);
  });

  // Approve a proposal. Branch 3 (review) → submit an approving PR review and
  // mark the task done (ownership then rests with the PR author).
  // Branch 1 (issue-origin implement) → bring the branch up to date with main
  // and open the proposed PR, then wait on the external PR lifecycle. Branch 1
  // (already-tracking PR) → merge the approved PR.
  app.post("/api/tasks/:id/approve", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseId(req, reply);
    if (id === null) return;
    const task = await getTask(id);
    if (!task) return reply.code(404).send({ error: "no such task" });
    if (task.state !== "awaiting_approval")
      return reply.code(409).send({ error: `cannot approve task in state ${task.state}` });

    if (task.kind === "review") {
      const pending = await requirePendingReview(id, reply, task);
      if (!pending) return;
      await approvePullRequestReview(
        getOctokit(),
        pending.task.repo_full_name,
        pending.task.subject_number,
        pending.review,
      );
      // The review is submitted — ownership passes to the PR author. If they push
      // new commits the poller/webhook starts a fresh review task, so this run is
      // done rather than lingering in awaiting_external until the PR merges.
      await setTaskState(id, "done", "PR review approved");
      await clearNotification(taskNotifyTag(id));
      logger.info({ taskId: id }, "PR review approved");
      return { ok: true };
    }

    if (task.kind === "implement" && trackedPrNumber(task) !== null) {
      return confirmMerge(id, reply, task);
    }

    if (task.kind === "implement" && task.pr_number === null) {
      if (!task.branch_name)
        return reply.code(409).send({ error: "task has no pushed branch" });
      const repo = getEnabledRepo(task.repo_full_name);
      if (!repo) return reply.code(409).send({ error: "repository is not enabled" });
      const title = (await readTaskArtifact(id, "PR_TITLE.md"))?.trim();
      const body = await readTaskArtifact(id, "PR_BODY.md");
      if (!title || body === null)
        return reply.code(404).send({ error: "no PR proposal to open" });

      const octokit = getOctokit();
      // Auto-rebase: merge the default branch into the feature branch first. A
      // "conflict" here just means the branch can't fast-merge base — that's
      // fine, the PR opens as unmergeable and the resolve_conflict pipeline
      // (it's assigned to me) picks it up. Don't block opening on it.
      await updateBranchFromBase(
        octokit,
        task.repo_full_name,
        task.branch_name,
        repo.default_branch,
      );

      const pr = await openPullRequest(octokit, task.repo_full_name, {
        title,
        body,
        head: task.branch_name,
        base: repo.default_branch,
        // Assign the PR to me (the repo login) so it lands in my assigned list.
        assignees: [repo.assignee_login],
      });
      await setTaskPrAndState(id, pr.number, "awaiting_external");
      // The PR is open — the "Open PR" notification is stale, dismiss it.
      await clearNotification(taskNotifyTag(id));
      logger.info({ taskId: id, prNumber: pr.number }, "PR proposal approved and opened");
      return { ok: true, prNumber: pr.number, prUrl: pr.htmlUrl };
    }

    return reply.code(409).send({ error: `cannot approve a ${task.kind} task` });
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
    await clearNotification(taskNotifyTag(id));
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
 * Extract a markdown body from a PUT. Accepts:
 *  - text/markdown or text/plain → a raw string;
 *  - application/json → a raw Buffer (the global HMAC parser), holding either a
 *    JSON string, a `{ "content": "…" }` object, or just raw markdown.
 */
function bodyText(
  req: FastifyRequest,
  opts: { allowEmpty?: boolean } = {},
): string | null {
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
  return typeof text === "string" && (opts.allowEmpty || text.trim() !== "")
    ? text
    : null;
}

/**
 * Parse a `{ title?, body? }` JSON payload for editing a PR proposal. Accepts a
 * raw Buffer (the global HMAC json parser), a JSON string, or an already-parsed
 * object. Returns null if it isn't a JSON object.
 */
function parsePrProposal(
  req: FastifyRequest,
): { title?: string; body?: string } | null {
  const b = req.body;
  let obj: unknown;
  if (Buffer.isBuffer(b)) {
    try {
      obj = JSON.parse(b.toString("utf8"));
    } catch {
      return null;
    }
  } else if (typeof b === "string") {
    try {
      obj = JSON.parse(b);
    } catch {
      return null;
    }
  } else {
    obj = b;
  }
  if (!obj || typeof obj !== "object") return null;
  const { title, body } = obj as { title?: unknown; body?: unknown };
  return {
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof body === "string" ? { body } : {}),
  };
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
