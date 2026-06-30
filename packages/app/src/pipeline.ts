import {
  addRun,
  closeSubjectTasks,
  createTaskWithRun,
  enqueueTask,
  findActiveTask,
  findTasksTrackingPr,
  findTasksWaitingOnPr,
  findOpenPrTask,
  getEnabledRepo,
  hasReviewTask,
  getOctokit,
  isAgentComment,
  loadEnv,
  logger,
  setTaskPrAndState,
  setTaskState,
  splitRepo,
  type JobPhase,
  type RepoConfig,
  type SubjectType,
  type Task,
  type TaskKind,
  type TaskRole,
} from "@kotx/shared";
import type { Octokit } from "@octokit/rest";
import type { Normalized, NormalizedSubject } from "./extract.js";

export type IngestResult =
  | { status: "ignored"; reason: string }
  | { status: "handled"; action: string }
  | { status: "enqueued"; taskId: number };

// ── task creation (shared with the poller) ──────────────────────────────────

async function enqueueRun(
  task: Task,
  runId: number,
  kind: TaskKind,
  phase: JobPhase,
): Promise<void> {
  await enqueueTask({
    taskId: task.id,
    taskRunId: runId,
    kind,
    phase,
    repoFullName: task.repo_full_name,
    subject: { type: task.subject_type, number: task.subject_number },
  });
}

interface NewTaskInput {
  repo: RepoConfig;
  subject: NormalizedSubject;
  kind: TaskKind;
  role: TaskRole;
  phase: JobPhase;
  initialState: "drafting" | "queued";
  triggeredBy: string;
  triggerCommentUrl?: string | null;
}

async function createAndEnqueue(input: NewTaskInput): Promise<IngestResult> {
  const created = await createTaskWithRun({
    repoFullName: input.repo.full_name,
    subjectType: input.subject.type,
    subjectNumber: input.subject.number,
    subjectTitle: input.subject.title || null,
    kind: input.kind,
    role: input.role,
    initialState: input.initialState,
    branchName: null, // the worker derives it (needs the issue/PR title)
    triggeredBy: input.triggeredBy,
    triggerCommentUrl: input.triggerCommentUrl ?? null,
    dataDir: loadEnv().agentDataDir,
  });
  if (!created) return { status: "ignored", reason: "already-active-race" };
  await enqueueRun(created.task, created.run.id, input.kind, input.phase);
  logger.info(
    { taskId: created.task.id, kind: input.kind, repo: input.repo.full_name },
    "task enqueued",
  );
  return { status: "enqueued", taskId: created.task.id };
}

/**
 * Branch 1: assignment or follow-up activity on an issue/PR I'm assigned to.
 * Produces a TASK.md draft that I later start from the frontend. A follow-up on
 * an existing draft re-runs the refinement instead of creating a duplicate.
 */
export async function startDraft(
  repo: RepoConfig,
  subject: NormalizedSubject,
  triggeredBy: string,
  triggerCommentUrl: string | null,
): Promise<IngestResult> {
  if (subject.state !== "open")
    return { status: "ignored", reason: "subject-closed" };

  const active = await findActiveTask(repo.full_name, subject.type, subject.number);
  if (active) {
    // Refresh an in-flight draft with the new activity; otherwise leave the
    // active task alone (don't pile work onto something already running).
    if (active.kind === "implement" && (active.state === "draft" || active.state === "drafting")) {
      const run = await addRun(active.id, loadEnv().agentDataDir);
      await enqueueRun(active, run.id, "implement", "draft");
      logger.info({ taskId: active.id }, "draft refreshed");
      return { status: "enqueued", taskId: active.id };
    }
    return { status: "ignored", reason: `already-active:${active.state}` };
  }

  return createAndEnqueue({
    repo,
    subject,
    kind: "implement",
    role: "assignee",
    phase: "draft",
    initialState: "drafting",
    triggeredBy,
    triggerCommentUrl,
  });
}

/** Branch 3: my review was requested (or a reviewed PR got new commits). */
export async function startReview(
  repo: RepoConfig,
  subject: NormalizedSubject,
  triggeredBy: string,
): Promise<IngestResult> {
  if (subject.state !== "open")
    return { status: "ignored", reason: "subject-closed" };

  const active = await findActiveTask(repo.full_name, subject.type, subject.number);
  if (active) {
    // Re-review on new commits: replace a stale review (queued / ready) with a
    // fresh run. Don't interrupt a review that's actively running.
    if (active.kind === "review" && active.state !== "running") {
      const run = await addRun(active.id, loadEnv().agentDataDir);
      await enqueueRun(active, run.id, "review", "execute");
      logger.info({ taskId: active.id }, "review refreshed");
      return { status: "enqueued", taskId: active.id };
    }
    return { status: "ignored", reason: `already-active:${active.state}` };
  }

  return createAndEnqueue({
    repo,
    subject,
    kind: "review",
    role: "reviewer",
    phase: "execute",
    initialState: "queued",
    triggeredBy,
  });
}

/** Branch 2: a PR assigned to me is unmergeable (conflicts) → auto-resolve. */
export async function maybeResolveConflict(
  repo: RepoConfig,
  subject: NormalizedSubject,
  triggeredBy: string,
): Promise<IngestResult> {
  if (subject.state !== "open" || subject.type !== "pull_request")
    return { status: "ignored", reason: "not-open-pr" };

  const dirty = await isConflicting(repo, subject.number);
  if (!dirty) return { status: "ignored", reason: "mergeable" };

  const active = await findActiveTask(repo.full_name, subject.type, subject.number);
  if (active) return { status: "ignored", reason: `already-active:${active.state}` };

  return createAndEnqueue({
    repo,
    subject,
    kind: "resolve_conflict",
    role: "assignee",
    phase: "execute",
    initialState: "queued",
    triggeredBy,
  });
}

/**
 * GitHub computes mergeability asynchronously, so `mergeable` is often null right
 * after an event. Poll pulls.get a few times until it settles. Conflicts surface
 * as mergeable=false / mergeable_state="dirty".
 */
async function isConflicting(repo: RepoConfig, prNumber: number): Promise<boolean> {
  const [owner, name] = splitRepo(repo.full_name);
  const octokit = getOctokit();
  for (let i = 0; i < 5; i++) {
    const { data } = await octokit.pulls.get({
      owner,
      repo: name,
      pull_number: prNumber,
    });
    if (data.state !== "open" || data.draft) return false;
    if (data.mergeable !== null)
      return data.mergeable === false && data.mergeable_state === "dirty";
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false; // never settled — treat as not-conflicting (re-checked on next event)
}

function prCloseReason(prNumber: number): string {
  return `PR #${prNumber} was closed without merging`;
}

export async function markPrOpened(
  repo: RepoConfig,
  prNumber: number,
  headRef: string | undefined,
  headRepoFullName: string | undefined,
  baseRef: string | undefined = repo.default_branch,
): Promise<number> {
  if (!headRef || headRepoFullName !== repo.full_name) return 0;
  if (baseRef !== repo.default_branch) return 0;
  const waiting = await findTasksWaitingOnPr(repo.full_name);
  let updated = 0;
  for (const task of waiting) {
    if (task.branch_name !== headRef) continue;
    await setTaskPrAndState(task.id, prNumber, "awaiting_external");
    updated++;
  }
  return updated;
}

export async function markPrClosed(
  repo: RepoConfig,
  prNumber: number,
  merged: boolean,
): Promise<number> {
  const tasks = await findTasksTrackingPr(repo.full_name, prNumber);
  let updated = 0;
  for (const task of tasks) {
    await setTaskState(
      task.id,
      merged ? "done" : "cancelled",
      merged ? null : prCloseReason(prNumber),
    );
    updated++;
  }

  const closed = await closeSubjectTasks(
    repo.full_name,
    "pull_request",
    prNumber,
    merged ? "done" : "cancelled",
    merged ? null : prCloseReason(prNumber),
  );
  return updated + closed;
}

export async function reconcileWaitingPrs(repo: RepoConfig): Promise<number> {
  const waiting = await findTasksWaitingOnPr(repo.full_name);
  if (waiting.length === 0) return 0;
  const [owner, name] = splitRepo(repo.full_name);
  const octokit = getOctokit();
  let updated = 0;
  for (const task of waiting) {
    if (!task.branch_name) continue;
    const prs = await octokit.pulls.list({
      owner,
      repo: name,
      state: "open",
      head: `${owner}:${task.branch_name}`,
      base: repo.default_branch,
      per_page: 10,
    });
    const pr = prs.data.find(
      (p) =>
        p.head?.ref === task.branch_name &&
        p.head?.repo?.full_name === repo.full_name &&
        p.base?.ref === repo.default_branch,
    );
    if (!pr) continue;
    await setTaskPrAndState(task.id, pr.number, "awaiting_external");
    updated++;
  }
  return updated;
}

export async function reconcileTrackedPr(
  repo: RepoConfig,
  prNumber: number,
): Promise<boolean> {
  const existing = await findOpenPrTask(repo.full_name, prNumber);
  if (!existing) return false;
  const [owner, name] = splitRepo(repo.full_name);
  const { data } = await getOctokit().pulls.get({
    owner,
    repo: name,
    pull_number: prNumber,
  });
  if (data.state === "open") return false;
  await markPrClosed(repo, prNumber, !!data.merged);
  return true;
}

// ── ingestion ───────────────────────────────────────────────────────────────

export async function ingest(n: Normalized): Promise<IngestResult> {
  const repo = getEnabledRepo(n.repoFullName);
  if (!repo) return { status: "ignored", reason: "repo-not-enabled" };
  const me = repo.assignee_login;

  // Lifecycle: PRs opened from pushed issue branches move those tasks to review;
  // closed/merged PRs end issue-origin and PR-origin tasks that track them.
  if (
    n.event === "pull_request" &&
    ["opened", "reopened"].includes(n.action) &&
    n.subject
  ) {
    const updated = await markPrOpened(
      repo,
      n.subject.number,
      n.subject.headRef,
      n.subject.headRepoFullName,
      n.subject.baseRef,
    );
    if (updated > 0) return { status: "handled", action: `pr-opened:${updated}` };
  }

  if (n.event === "pull_request" && n.action === "closed" && n.subject) {
    const closed = await markPrClosed(
      repo,
      n.subject.number,
      !!n.subject.merged,
    );
    return { status: "handled", action: `closed:${closed}` };
  }

  // Branch 2 fan-out: a push to the default branch may have made my open PRs
  // conflict with main.
  if (n.event === "push") {
    if (n.pushRef !== `refs/heads/${repo.default_branch}`)
      return { status: "ignored", reason: "non-default-push" };
    return rescanConflicts(repo, me);
  }

  const subject = n.subject;
  if (!subject) return { status: "ignored", reason: "no-subject" };

  // Branch 3: review explicitly requested.
  if (n.event === "pull_request" && n.action === "review_requested") {
    if (n.targetLogin !== me) return { status: "ignored", reason: "reviewer-not-me" };
    return startReview(repo, subject, n.senderLogin);
  }

  // New commits / (re)open: re-review the PR if my review is requested OR I have
  // already reviewed it (GitHub drops me from requested_reviewers once a review is
  // recorded, so requested_reviewers alone misses re-reviews). Otherwise, if the
  // PR is assigned to me, re-check mergeability (Branch 2).
  if (
    n.event === "pull_request" &&
    ["synchronize", "opened", "reopened"].includes(n.action)
  ) {
    if (
      subject.requestedReviewers.includes(me) ||
      (await hasReviewTask(repo.full_name, subject.number))
    )
      return startReview(repo, subject, n.senderLogin);
    if (subject.assignees.includes(me))
      return maybeResolveConflict(repo, subject, n.senderLogin);
    return { status: "ignored", reason: "pr-not-mine" };
  }

  // Branch 1: assignment to an ISSUE → produce a task draft.
  if (n.event === "issues" && n.action === "assigned") {
    if (n.targetLogin !== me && !subject.assignees.includes(me))
      return { status: "ignored", reason: "assignee-not-me" };
    return startDraft(repo, subject, n.senderLogin, null);
  }

  // A PR assigned to me is NOT a Branch 1 trigger — assignee work on a PR is
  // Branch 2 (conflict resolution). Check mergeability instead of drafting.
  if (n.event === "pull_request" && n.action === "assigned") {
    if (n.targetLogin !== me && !subject.assignees.includes(me))
      return { status: "ignored", reason: "assignee-not-me" };
    return maybeResolveConflict(repo, subject, n.senderLogin);
  }

  // Branch 1: a comment or review on an issue/PR I'm assigned to. A human
  // follow-up from the agent's own account still triggers; only the agent's own
  // posts (carrying the marker) are skipped to avoid a self-loop.
  if (n.comment) {
    if (!subject.assignees.includes(me))
      return { status: "ignored", reason: "not-assigned-to-me" };
    if (isAgentComment(n.comment.body))
      return { status: "ignored", reason: "agent-comment" };
    return startDraft(repo, subject, n.comment.authorLogin, n.comment.htmlUrl || null);
  }

  return { status: "ignored", reason: "non-trigger" };
}

/** List my open PRs and create a resolve-conflict task for any now-dirty one. */
async function rescanConflicts(
  repo: RepoConfig,
  me: string,
): Promise<IngestResult> {
  const [owner, name] = splitRepo(repo.full_name);
  const octokit: Octokit = getOctokit();
  const prs = await octokit.pulls.list({ owner, repo: name, state: "open", per_page: 100 });
  let enqueued = 0;
  for (const pr of prs.data) {
    const assignees = (pr.assignees ?? []).map((a) => a?.login).filter(Boolean);
    if (!assignees.includes(me)) continue;
    const subject: NormalizedSubject = {
      type: "pull_request",
      number: pr.number,
      state: "open",
      assignees: assignees as string[],
      requestedReviewers: [],
      title: pr.title ?? "",
      body: pr.body ?? "",
      headRef: pr.head?.ref,
      headRepoFullName: pr.head?.repo?.full_name ?? undefined,
      baseRef: pr.base?.ref,
    };
    const res = await maybeResolveConflict(repo, subject, me);
    if (res.status === "enqueued") enqueued++;
  }
  return { status: "handled", action: `rescan-conflicts:${enqueued}` };
}

// re-exported for the poller
export type { SubjectType };
