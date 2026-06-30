import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireRepoSlot,
  clearCancelFlag,
  enqueueTask,
  finishRun,
  getEnabledRepo,
  getOctokit,
  getRun,
  getTask,
  gitToken,
  isCancelled,
  loadDefaults,
  loadEnv,
  logger,
  markRunStarted,
  maxWorkersForRepo,
  releaseRepoSlot,
  runDirFor,
  setTaskBranch,
  setTaskState,
  taskDirFor,
  TERMINAL_STATES,
  type RunOutcome,
  type Task,
  type TaskJob,
  type TaskState,
} from "@kotx/shared";
import { ensureFreshAuth } from "./codexAuth.js";
import {
  addImplementWorktree,
  commitAll,
  ensureMirrorFetched,
  findConflictMarkers,
  issueBranchName,
  mergeDefaultBranch,
  mirrorPath,
  pushBranch,
  removeWorktree,
} from "./git.js";
import {
  fetchSubject,
  postFailureComment,
  postSummary,
  type SubjectDetails,
} from "./githubOutputs.js";
import { notify } from "./notify.js";
import {
  classifyOutcome,
  deleteArtifacts,
  readArtifact,
  readArtifacts,
} from "./outputs.js";
import { containerName, killContainer, runCodexContainer } from "./runner.js";
import { renderPrompt, type PromptKind, type TaskContext } from "./templates.js";

const RETRY_DELAY_MS = 5000;
const CANCEL_POLL_MS = 3000;

function subjectLabel(task: Task): string {
  const kind = task.subject_type === "pull_request" ? "PR" : "Issue";
  return `${kind} #${task.subject_number}`;
}

function subjectKindWord(task: Task): string {
  return task.subject_type === "pull_request" ? "pull request" : "issue";
}

/** Frontend URL opened when tapping a Home Assistant notification. */
function notifyUrl(): string | undefined {
  return loadEnv().corsOrigin;
}

const STATE_WORD: Record<string, string> = {
  draft: "ready for your review",
  awaiting_approval: "review ready",
  awaiting_external: "pushed",
  done: "completed",
  failed: "failed",
  timed_out: "timed out",
  cancelled: "cancelled",
};

interface Guarded {
  exitCode: number;
  killedByTimeout: boolean;
  killedByCancel: boolean;
}

/** Run the container with a wall-clock kill and a cancel-flag poller (SPEC §8). */
async function runWithGuards(
  name: string,
  runId: number,
  worktreePath: string,
  runOutputDir: string,
  mirror: string,
  taskId: number,
): Promise<Guarded> {
  const wallClock = loadDefaults().timeouts.task_wall_clock_sec;
  let killedByTimeout = false;
  let killedByCancel = false;

  const timeout = setTimeout(() => {
    killedByTimeout = true;
    void killContainer(name);
  }, wallClock * 1000);

  const poller = setInterval(() => {
    void isCancelled(taskId).then((c) => {
      if (c) {
        killedByCancel = true;
        void killContainer(name);
      }
    });
  }, CANCEL_POLL_MS);

  try {
    const exitCode = await runCodexContainer({
      name,
      runId,
      worktreePath,
      runOutputDir,
      mirrorPath: mirror,
    });
    return { exitCode, killedByTimeout, killedByCancel };
  } finally {
    clearTimeout(timeout);
    clearInterval(poller);
  }
}

function defaultCommitMsg(task: Task): string {
  return `Changes for #${task.subject_number}\n`;
}

/** Map a non-completed outcome to the terminal task state. */
function failureState(outcome: RunOutcome): TaskState {
  if (outcome === "timed_out") return "timed_out";
  if (outcome === "cancelled") return "cancelled";
  return "failed";
}

/** A short, human-readable reason for a non-completed run (for notifications). */
function describeRunFailure(outcome: RunOutcome, exitCode: number): string {
  if (outcome === "timed_out") return "the run timed out";
  if (outcome === "cancelled") return "cancelled";
  return exitCode !== 0
    ? `Codex exited with code ${exitCode}`
    : "Codex produced no result";
}

// Everything a run handler needs after the worktree is checked out.
interface RunCtx {
  task: Task;
  runId: number;
  repoFullName: string;
  defaultBranch: string;
  octokit: ReturnType<typeof getOctokit>;
  subject: SubjectDetails;
  branch: string;
  worktreePath: string;
  runOutputDir: string;
  taskDir: string;
  containerName: string;
  mirror: string;
  // a draft run is a follow-up (new activity) rather than a first assignment
  followUp: boolean;
  // record why a run failed, surfaced in the finish notification
  setReason: (reason: string) => void;
}

/** Render the prompt, write it as PROMPT.md, and run the guarded container. */
async function runPrompt(
  ctx: RunCtx,
  kind: PromptKind,
  extra: Partial<TaskContext>,
): Promise<Guarded> {
  const prompt = renderPrompt(kind, {
    repoFullName: ctx.repoFullName,
    subjectKind: subjectKindWord(ctx.task),
    subjectNumber: ctx.task.subject_number,
    branchName: ctx.branch,
    defaultBranch: ctx.defaultBranch,
    title: ctx.subject.title,
    body: ctx.subject.body,
    comments: ctx.subject.comments,
    dockerAvailable: loadDefaults().container.dev_containers,
    ...extra,
  });
  await writeFile(join(ctx.runOutputDir, "PROMPT.md"), prompt, "utf8");
  await ensureFreshAuth();
  return runWithGuards(
    ctx.containerName,
    ctx.runId,
    ctx.worktreePath,
    ctx.runOutputDir,
    ctx.mirror,
    ctx.task.id,
  );
}

// ── per-kind run handlers ───────────────────────────────────────────────────

/** Branch 1, draft phase: read-only refinement → TASK.md, then await my start. */
async function runDraft(ctx: RunCtx): Promise<void> {
  const guarded = await runPrompt(ctx, "draft", { isFollowUp: ctx.followUp });
  const taskMd = await readArtifact(ctx.worktreePath, "TASK.md");
  const outcome = classifyOutcome({
    exitCode: guarded.exitCode,
    producedOutput: taskMd !== null,
    killedByCancel: guarded.killedByCancel,
    killedByTimeout: guarded.killedByTimeout,
  });
  await finishRun(ctx.runId, {
    outcome,
    exitCode: guarded.exitCode,
    resultMd: taskMd,
  });
  if (outcome === "completed" && taskMd) {
    await mkdir(ctx.taskDir, { recursive: true });
    await writeFile(join(ctx.taskDir, "TASK.md"), taskMd, "utf8");
    await setTaskState(ctx.task.id, "draft");
  } else {
    ctx.setReason(describeRunFailure(outcome, guarded.exitCode));
    await setTaskState(ctx.task.id, failureState(outcome));
  }
  await removeWorktree(ctx.repoFullName, ctx.worktreePath);
}

/** Branch 1, execute phase: implement the approved brief, push, comment. */
async function runImplement(ctx: RunCtx, merge: MergeResult): Promise<void> {
  const brief =
    (await readArtifact(ctx.taskDir, "TASK.md")) ??
    `${ctx.subject.title}\n\n${ctx.subject.body}`;
  const guarded = await runPrompt(ctx, "implement", {
    taskBrief: brief,
    mergeConflicts: merge.conflicted ? merge.files : undefined,
  });
  await finalizeWrite(ctx, guarded, merge, {
    forceWithLease: ctx.task.subject_type === "issue",
    successState: "awaiting_external",
  });
}

/** Branch 2: resolve the in-progress conflicted merge, then push. */
async function runResolveConflict(ctx: RunCtx, merge: MergeResult): Promise<void> {
  if (!merge.conflicted) {
    // Nothing to reconcile (already clean). Push if the merge advanced the branch.
    if (merge.advanced)
      await pushBranch(ctx.repoFullName, ctx.branch, gitToken());
    await finishRun(ctx.runId, { outcome: "completed", exitCode: 0, resultMd: null });
    await setTaskState(ctx.task.id, merge.advanced ? "awaiting_external" : "done");
    await removeWorktree(ctx.repoFullName, ctx.worktreePath);
    return;
  }
  const guarded = await runPrompt(ctx, "resolve_conflict", {
    mergeConflicts: merge.files,
  });
  await finalizeWrite(ctx, guarded, merge, {
    forceWithLease: false,
    successState: "awaiting_external",
  });
}

/** Branch 3: read-only review → REVIEW.md, then await my approval to post it. */
async function runReview(ctx: RunCtx): Promise<void> {
  const guarded = await runPrompt(ctx, "review", {});
  const reviewMd = await readArtifact(ctx.worktreePath, "REVIEW.md");
  const outcome = classifyOutcome({
    exitCode: guarded.exitCode,
    producedOutput: reviewMd !== null,
    killedByCancel: guarded.killedByCancel,
    killedByTimeout: guarded.killedByTimeout,
  });
  await finishRun(ctx.runId, {
    outcome,
    exitCode: guarded.exitCode,
    resultMd: reviewMd,
  });
  if (outcome === "completed" && reviewMd) {
    await mkdir(ctx.taskDir, { recursive: true });
    await writeFile(join(ctx.taskDir, "REVIEW.md"), reviewMd, "utf8");
    await setTaskState(ctx.task.id, "awaiting_approval");
  } else {
    ctx.setReason(describeRunFailure(outcome, guarded.exitCode));
    await setTaskState(ctx.task.id, failureState(outcome));
  }
  await removeWorktree(ctx.repoFullName, ctx.worktreePath);
}

/** Shared tail for the write-kinds (implement, resolve_conflict): classify,
 *  guard against leftover conflict markers, commit, push, comment. */
async function finalizeWrite(
  ctx: RunCtx,
  guarded: Guarded,
  merge: MergeResult,
  opts: { forceWithLease: boolean; successState: TaskState },
): Promise<void> {
  const artifacts = await readArtifacts(ctx.worktreePath);
  const outcome = classifyOutcome({
    exitCode: guarded.exitCode,
    producedOutput: artifacts.resultMd !== null,
    killedByCancel: guarded.killedByCancel,
    killedByTimeout: guarded.killedByTimeout,
  });
  await finishRun(ctx.runId, {
    outcome,
    exitCode: guarded.exitCode,
    resultMd: artifacts.resultMd,
  });

  if (outcome !== "completed") {
    ctx.setReason(describeRunFailure(outcome, guarded.exitCode));
    await setTaskState(ctx.task.id, failureState(outcome));
    if (outcome !== "cancelled")
      await postFailureComment(
        ctx.octokit,
        ctx.repoFullName,
        ctx.task.subject_number,
        outcome === "timed_out" ? "the run timed out" : "the run failed",
      );
    await removeWorktree(ctx.repoFullName, ctx.worktreePath);
    return;
  }

  // safety net: never commit unresolved merge conflicts
  const markers = await findConflictMarkers(ctx.worktreePath);
  if (markers.length) {
    const reason = `unresolved merge conflict markers in: ${markers.slice(0, 20).join(", ")}`;
    ctx.setReason(reason);
    await setTaskState(ctx.task.id, "failed");
    await postFailureComment(
      ctx.octokit,
      ctx.repoFullName,
      ctx.task.subject_number,
      reason,
    );
    await removeWorktree(ctx.repoFullName, ctx.worktreePath);
    return;
  }

  const msgFile = join(ctx.runOutputDir, "COMMIT_MSG.txt");
  await writeFile(
    msgFile,
    artifacts.commitMsg ?? defaultCommitMsg(ctx.task),
    "utf8",
  );
  await deleteArtifacts(ctx.worktreePath);
  const committed = await commitAll(ctx.worktreePath, msgFile);
  if (committed || merge.advanced) {
    await pushBranch(ctx.repoFullName, ctx.branch, gitToken(), {
      forceWithLease: opts.forceWithLease,
    });
  }

  const summary = artifacts.resultMd ?? "Done.";
  const isIssue = ctx.task.subject_type === "issue";
  const body =
    isIssue && committed
      ? `${summary}\n\nChanges pushed to \`${ctx.branch}\`.`
      : summary;
  await postSummary(ctx.octokit, ctx.repoFullName, ctx.task.subject_number, body);
  await setTaskState(ctx.task.id, opts.successState);
  await removeWorktree(ctx.repoFullName, ctx.worktreePath);
}

interface MergeResult {
  conflicted: boolean;
  files: string[];
  advanced: boolean;
}

export async function processJob(job: TaskJob): Promise<void> {
  const env = loadEnv();
  const task = await getTask(job.taskId);
  const run = await getRun(job.taskRunId);
  if (!task || !run) {
    logger.warn({ job }, "task/run missing; dropping job");
    return;
  }
  if (TERMINAL_STATES.has(task.state)) {
    logger.info({ taskId: task.id, state: task.state }, "task terminal; skip");
    return;
  }
  const repo = getEnabledRepo(task.repo_full_name);
  if (!repo) {
    await setTaskState(task.id, "failed");
    return;
  }

  const holderId = `run-${run.id}`;
  const lockTtl =
    loadDefaults().timeouts.task_wall_clock_sec +
    loadDefaults().timeouts.repo_lock_buffer_sec;
  const maxSlots = maxWorkersForRepo(repo);
  const slot = await acquireRepoSlot(
    task.repo_full_name,
    holderId,
    maxSlots,
    lockTtl,
  );
  if (slot === null) {
    // Repo at capacity. Re-enqueue this run with a delay and a FRESH job id —
    // re-adding `run-<id>` while the current job is still active would be
    // de-duplicated by BullMQ and silently dropped (the old clog bug). Return
    // immediately so this worker slot is freed for other repos.
    await enqueueTask(job, {
      jobId: `run-${run.id}-retry-${Date.now()}`,
      delayMs: RETRY_DELAY_MS,
    });
    logger.debug({ repo: task.repo_full_name, maxSlots }, "repo busy; requeued");
    return;
  }

  const worktreePath = run.worktree_path;
  const runOutputDir = runDirFor(env.agentDataDir, run.id);
  const isPr = task.subject_type === "pull_request";
  const name = containerName(run.id);
  const isWriteKind =
    job.kind === "resolve_conflict" || (job.kind === "implement" && job.phase === "execute");
  let started = false;
  let failureReason: string | undefined;

  try {
    if (await isCancelled(task.id)) {
      await setTaskState(task.id, "cancelled");
      return;
    }

    await setTaskState(task.id, job.phase === "draft" ? "drafting" : "running");
    await markRunStarted(run.id, name, join(runOutputDir, "codex.jsonl"));
    await mkdir(runOutputDir, { recursive: true });
    await notify({
      title: `${subjectLabel(task)} started`,
      message: task.repo_full_name,
      tag: `kotx-task-${task.id}`,
      url: notifyUrl(),
    });
    started = true;

    const octokit = getOctokit();
    const subject = await fetchSubject(
      octokit,
      task.repo_full_name,
      task.subject_type,
      task.subject_number,
    );

    // Decide the branch + start ref. Issues get a fresh GitHub-style branch off
    // the default branch; PRs use their own head branch. Fork PRs can't be pushed
    // to, so write-kinds bail; the read-only review reads the fork's head via the
    // mirror's refs/pull/* namespace.
    let branch: string;
    let baseSuffix: string;
    if (!isPr) {
      branch = issueBranchName(task.subject_number, subject.title);
      baseSuffix = repo.default_branch;
    } else {
      if (!subject.headRef) throw new Error("PR has no head ref");
      const isFork =
        !!subject.headRepoFullName &&
        subject.headRepoFullName !== task.repo_full_name;
      if (isFork && isWriteKind) {
        failureReason = "this PR is from a fork — its branch can't be pushed to";
        await finishRun(run.id, { outcome: "failed", exitCode: null, resultMd: null });
        await setTaskState(task.id, "failed");
        await postFailureComment(
          octokit,
          task.repo_full_name,
          task.subject_number,
          failureReason,
        );
        return;
      }
      branch = isFork ? `review/pr-${task.subject_number}` : subject.headRef;
      baseSuffix = isFork ? `pull/${task.subject_number}` : subject.headRef;
    }
    await setTaskBranch(task.id, branch);

    const token = gitToken();
    await ensureMirrorFetched(task.repo_full_name, token);
    await removeWorktree(task.repo_full_name, worktreePath);
    await addImplementWorktree(task.repo_full_name, worktreePath, branch, baseSuffix);

    const ctx: RunCtx = {
      task,
      runId: run.id,
      repoFullName: task.repo_full_name,
      defaultBranch: repo.default_branch,
      octokit,
      subject,
      branch,
      worktreePath,
      runOutputDir,
      taskDir: taskDirFor(env.agentDataDir, task.id),
      containerName: name,
      mirror: mirrorPath(task.repo_full_name),
      // a draft is a follow-up if the task already had a previous run
      followUp: run.attempt > 1,
      setReason: (reason) => {
        failureReason = reason;
      },
    };

    // Only the write-kinds merge the default branch in first. resolve_conflict
    // expects conflicts; implement-execute wants to build on top of latest main.
    let merge: MergeResult = { conflicted: false, files: [], advanced: false };
    if (isWriteKind) {
      merge = await mergeDefaultBranch(worktreePath, repo.default_branch);
      if (merge.conflicted)
        logger.info(
          { taskId: task.id, files: merge.files },
          "merge conflicts present",
        );
    }

    if (job.kind === "implement" && job.phase === "draft") await runDraft(ctx);
    else if (job.kind === "implement") await runImplement(ctx, merge);
    else if (job.kind === "resolve_conflict") await runResolveConflict(ctx, merge);
    else if (job.kind === "review") await runReview(ctx);
    else throw new Error(`unknown job kind: ${job.kind}`);

    logger.info({ taskId: task.id, runId: run.id, kind: job.kind }, "run finished");
  } catch (err) {
    logger.error({ err, taskId: task.id }, "job failed");
    failureReason = err instanceof Error ? err.message : String(err);
    await setTaskState(task.id, "failed").catch(() => {});
    await removeWorktree(task.repo_full_name, worktreePath).catch(() => {});
  } finally {
    if (started) {
      const fresh = await getTask(task.id).catch(() => undefined);
      const state = fresh?.state ?? "failed";
      // include the failure reason in the message so the push notification is
      // actionable (e.g. "Codex exited with code 1", "the run timed out").
      const isFailed = state === "failed" || state === "timed_out";
      const message =
        isFailed && failureReason
          ? `${task.repo_full_name} — ${failureReason}`
          : task.repo_full_name;
      await notify({
        title: `${subjectLabel(task)} ${STATE_WORD[state] ?? state}`,
        message,
        tag: `kotx-task-${task.id}`,
        url: notifyUrl(),
      }).catch(() => {});
    }
    await releaseRepoSlot(task.repo_full_name, slot, holderId).catch(() => {});
    await clearCancelFlag(task.id).catch(() => {});
  }
}
