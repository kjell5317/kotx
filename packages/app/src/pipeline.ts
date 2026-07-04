import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addRun,
  clearNotification,
  closeSubjectTasks,
  createTaskWithRun,
  emitTaskStateChanged,
  enqueueTask,
  findActiveTask,
  findInReviewImplementTaskForPr,
  findNonTerminalTask,
  findInReviewTasksTrackingAnyPr,
  findTasksTrackingPr,
  findTasksWaitingOnPr,
  findOpenPrTask,
  getEnabledRepo,
  hasReviewTask,
  getOctokit,
  isAgentComment,
  isUniqueViolation,
  loadEnv,
  logger,
  notify,
  setCancelFlag,
  setTaskPrAndState,
  setTaskState,
  setTaskTrigger,
  splitRepo,
  taskDirFor,
  taskNotifyTag,
  type DraftFollowUpInput,
  type JobPhase,
  type PullRequestReviewInput,
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
  followUpInput?: DraftFollowUpInput,
): Promise<void> {
  await enqueueTask({
    taskId: task.id,
    taskRunId: runId,
    kind,
    phase,
    repoFullName: task.repo_full_name,
    subject: { type: task.subject_type, number: task.subject_number },
    followUpInput,
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
  followUpInput?: DraftFollowUpInput;
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
  await enqueueRun(
    created.task,
    created.run.id,
    input.kind,
    input.phase,
    input.followUpInput,
  );
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
  followUpInput?: DraftFollowUpInput,
): Promise<IngestResult> {
  if (subject.state !== "open")
    return { status: "ignored", reason: "subject-closed" };

  // One task per (repo, subjectNumber, kind) while non-terminal: repeat
  // triggers fold into the existing implement task instead of adding rows.
  const existing = await findNonTerminalTask(
    repo.full_name,
    subject.number,
    "implement",
  );
  if (existing) {
    // A follow-up re-runs the DRAFT phase so the feedback lands in TASK.md — the
    // execute phase reads TASK.md, not the raw comment, so re-drafting (then a
    // human "Start implementation") is how feedback reaches the code. This also
    // covers a comment on the open PR of an issue-origin task (awaiting_external,
    // nothing in flight): re-drafting re-engages it, and the later execute builds
    // on the existing PR branch (deterministic name) and pushes an update.
    // Work already running (queued/running) is NOT interrupted — record the
    // trigger and let the webhook surface the follow-up.
    const reDraftable =
      existing.state === "draft" ||
      existing.state === "drafting" ||
      existing.state === "awaiting_external";
    if (reDraftable) {
      const run = await addRun(existing.id, loadEnv().agentDataDir);
      await setTaskTrigger(existing.id, triggeredBy, triggerCommentUrl);
      await enqueueRun(existing, run.id, "implement", "draft", followUpInput);
      // No webhook here: the state is still unchanged, so emitting would send a
      // redundant no-op event. The worker fires the real transition (→ drafting)
      // when it picks up the run.
      logger.info(
        { taskId: existing.id, triggeredBy, fromState: existing.state },
        "draft refreshed",
      );
      return { status: "enqueued", taskId: existing.id };
    }
    await setTaskTrigger(existing.id, triggeredBy, triggerCommentUrl);
    emitTaskStateChanged(existing.id, existing.state);
    logger.info(
      { taskId: existing.id, state: existing.state, triggeredBy },
      "follow-up recorded on existing task",
    );
    return { status: "handled", action: `task-refreshed:${existing.id}` };
  }

  // A different-kind task may still hold the subject's single active slot.
  const active = await findActiveTask(repo.full_name, subject.type, subject.number);
  if (active) return { status: "ignored", reason: `already-active:${active.state}` };

  return createAndEnqueue({
    repo,
    subject,
    kind: "implement",
    role: "assignee",
    phase: "draft",
    initialState: "drafting",
    triggeredBy,
    triggerCommentUrl,
    followUpInput,
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

  // One task per (repo, subjectNumber, kind) while non-terminal: a repeated
  // review trigger refreshes the existing review task; a new row only appears
  // after the previous review is terminal.
  const existing = await findNonTerminalTask(
    repo.full_name,
    subject.number,
    "review",
  );
  if (existing) {
    // Re-review on new commits: replace a stale review (queued / ready) with a
    // fresh run. Don't interrupt a review that's actively running.
    if (existing.state !== "running") {
      const run = await addRun(existing.id, loadEnv().agentDataDir);
      await enqueueRun(existing, run.id, "review", "execute");
      emitTaskStateChanged(existing.id, existing.state);
      logger.info({ taskId: existing.id }, "review refreshed");
      return { status: "enqueued", taskId: existing.id };
    }
    return { status: "ignored", reason: `already-active:${existing.state}` };
  }

  // A different-kind task may still hold the subject's single active slot.
  const active = await findActiveTask(repo.full_name, subject.type, subject.number);
  if (active) return { status: "ignored", reason: `already-active:${active.state}` };

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
  if (active) {
    // A parked follow-up draft (waiting on "Start implementation", no run in
    // flight) must not starve conflict resolution forever — the same priority
    // rule pollPulls applies at creation time: conflicts win the slot. Cancel
    // the draft (cancel flag also stops a just-enqueued draft run, mirroring
    // the discard endpoint) and let the resolve task take over; a fresh
    // follow-up draft reopens on the next comment once the PR is mergeable.
    const parkedDraft = active.kind === "implement" && active.state === "draft";
    if (!parkedDraft)
      return { status: "ignored", reason: `already-active:${active.state}` };
    await setCancelFlag(active.id);
    await setTaskState(active.id, "cancelled", "preempted by conflict resolution");
    await clearNotification(taskNotifyTag(active.id));
    logger.info(
      { taskId: active.id, prNumber: subject.number },
      "parked draft preempted by conflict resolution",
    );
  }

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
 * A PR's mergeability. GitHub computes it asynchronously, so `mergeable` is often
 * null right after an event; poll pulls.get a few times until it settles.
 *   - "dirty":   conflicts with the base branch (needs resolve_conflict)
 *   - "clean":   mergeable, closed, or a GitHub draft — nothing to resolve
 *   - "unknown": GitHub hasn't computed it yet within this call; the caller
 *                should retry on the next poll/event rather than assume "clean"
 * The tri-state matters: callers must NOT treat "unknown" as "clean", or they'll
 * take slot-stealing actions (e.g. starting a draft) before a pending conflict is
 * detected — which then blocks the resolve on later ticks.
 */
export async function prMergeState(
  repo: RepoConfig,
  prNumber: number,
): Promise<"dirty" | "clean" | "unknown"> {
  const [owner, name] = splitRepo(repo.full_name);
  const octokit = getOctokit();
  for (let i = 0; i < 5; i++) {
    const { data } = await octokit.pulls.get({
      owner,
      repo: name,
      pull_number: prNumber,
    });
    if (data.state !== "open" || data.draft) return "clean";
    if (data.mergeable !== null)
      return data.mergeable === false && data.mergeable_state === "dirty"
        ? "dirty"
        : "clean";
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "unknown"; // never settled — re-checked on the next poll/event
}

async function isConflicting(repo: RepoConfig, prNumber: number): Promise<boolean> {
  return (await prMergeState(repo, prNumber)) === "dirty";
}

function logins(
  arr: Array<{ login?: string | null } | null> | null | undefined,
): string[] {
  return (arr ?? [])
    .map((x) => x?.login)
    .filter((l): l is string => !!l);
}

function prCloseReason(prNumber: number): string {
  return `PR #${prNumber} was closed without merging`;
}

function trackedPrNumber(task: Task): number | null {
  return task.pr_number ??
    (task.subject_type === "pull_request" ? task.subject_number : null);
}

function mergeApprovalArtifact(input: {
  review: PullRequestReviewInput;
}): string {
  const body = input.review.body.trim();
  return `${body || "_No approval comment provided._"}\n`;
}

/** Move an in-review implement task back to human approval after PR approval. */
export async function proposeMergeForApprovedReview(
  repo: RepoConfig,
  subject: NormalizedSubject,
  review: PullRequestReviewInput,
): Promise<IngestResult> {
  if (subject.type !== "pull_request" || subject.state !== "open")
    return { status: "ignored", reason: "not-open-pr" };
  if (review.state !== "approved")
    return { status: "ignored", reason: "review-not-approved" };
  if (isAgentComment(review.body))
    return { status: "ignored", reason: "agent-comment" };

  const task = await findInReviewImplementTaskForPr(
    repo.full_name,
    subject.number,
  );
  if (!task) return { status: "ignored", reason: "no-in-review-task" };

  const prNumber = trackedPrNumber(task);
  if (!prNumber) return { status: "ignored", reason: "task-has-no-pr" };

  const dir = taskDirFor(loadEnv().agentDataDir, task.id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "MERGE_APPROVAL.md"),
    mergeApprovalArtifact({ review }),
    "utf8",
  );

  try {
    await setTaskTrigger(task.id, review.authorLogin, review.htmlUrl);
    await setTaskState(task.id, "awaiting_approval");
  } catch (err) {
    if (isUniqueViolation(err)) {
      logger.info(
        { taskId: task.id, prNumber },
        "merge proposal skipped because subject already has an active task",
      );
      return { status: "ignored", reason: "already-active-race" };
    }
    throw err;
  }

  await notify({
    title: `PR #${prNumber} approved`,
    message: "Confirm merge",
    tag: taskNotifyTag(task.id),
  }).catch(() => {});
  logger.info(
    { taskId: task.id, prNumber, reviewer: review.authorLogin },
    "merge proposal created from approving review",
  );
  return { status: "handled", action: `merge-proposed:${task.id}` };
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
    // The PR is gone — any pending prompt for this task (e.g. "Comment review")
    // is stale, so dismiss it. Covers closeSubjectTasks' set too: its subject=PR
    // rows are a subset of the tasks found here.
    await clearNotification(taskNotifyTag(task.id));
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

/**
 * Re-check every tracked PR (in review or awaiting merge confirmation) for
 * conflicts. This complements the assignee-only polling path and
 * webhook/default-branch events, so a PR that becomes dirty while it is
 * already awaiting external review — or while a merge proposal sits
 * unconfirmed — heals itself on a later periodic tick.
 */
export async function scanTrackedPrConflicts(
  repo: RepoConfig,
): Promise<IngestResult> {
  const tasks = await findInReviewTasksTrackingAnyPr(repo.full_name);
  if (tasks.length === 0)
    return { status: "handled", action: "tracked-conflicts:0" };

  const [owner, name] = splitRepo(repo.full_name);
  const octokit: Octokit = getOctokit();
  const seen = new Set<number>();
  let enqueued = 0;
  let unknown = 0;

  for (const task of tasks) {
    const prNumber = trackedPrNumber(task);
    if (!prNumber || seen.has(prNumber)) continue;
    seen.add(prNumber);

    try {
      const { data: pr } = await octokit.pulls.get({
        owner,
        repo: name,
        pull_number: prNumber,
      });
      if (pr.state !== "open") continue;

      const merge = await prMergeState(repo, prNumber);
      if (merge === "unknown") {
        unknown++;
        continue;
      }
      if (merge !== "dirty") continue;

      const subject: NormalizedSubject = {
        type: "pull_request",
        number: pr.number,
        state: "open",
        assignees: logins(pr.assignees),
        requestedReviewers: logins(pr.requested_reviewers),
        title: pr.title ?? "",
        body: pr.body ?? "",
        headRef: pr.head?.ref,
        headRepoFullName: pr.head?.repo?.full_name ?? undefined,
        baseRef: pr.base?.ref,
      };
      const res = await maybeResolveConflict(repo, subject, repo.assignee_login);
      if (res.status === "enqueued") enqueued++;
    } catch (err) {
      logger.warn(
        { err, repo: repo.full_name, prNumber },
        "tracked conflict scan failed for PR",
      );
    }
  }

  return {
    status: "handled",
    action: `tracked-conflicts:${enqueued}:unknown:${unknown}`,
  };
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

  if (
    n.event === "pull_request_review" &&
    n.pullRequestReview?.state === "approved"
  ) {
    if (!subject.assignees.includes(me))
      return { status: "ignored", reason: "not-assigned-to-me" };
    return proposeMergeForApprovedReview(repo, subject, n.pullRequestReview);
  }

  // Branch 1: a comment or review on an issue/PR I'm assigned to. A human
  // follow-up from the agent's own account still triggers; only the agent's own
  // posts (carrying the marker) are skipped to avoid a self-loop.
  if (n.comment) {
    if (isAgentComment(n.comment.body))
      return { status: "ignored", reason: "agent-comment" };
    // A comment/review on a PR I'm reviewing → re-review (Branch 3); a comment on
    // a subject I'm assigned to → Branch 1 follow-up.
    const iReview =
      subject.type === "pull_request" &&
      (subject.requestedReviewers.includes(me) ||
        (await hasReviewTask(repo.full_name, subject.number)));
    if (iReview) return startReview(repo, subject, n.comment.authorLogin);
    if (!subject.assignees.includes(me))
      return { status: "ignored", reason: "not-assigned-to-me" };
    return startDraft(
      repo,
      subject,
      n.comment.authorLogin,
      n.comment.htmlUrl || null,
      n.comment,
    );
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
    const assignees = logins(pr.assignees);
    if (!assignees.includes(me)) continue;
    const subject: NormalizedSubject = {
      type: "pull_request",
      number: pr.number,
      state: "open",
      assignees,
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
