import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireRepoLock,
  clearCancelFlag,
  createHitlRequest,
  enqueueTask,
  finishRun,
  getEnabledRepo,
  getHitlById,
  getOctokit,
  getRun,
  getTask,
  gitToken,
  isCancelled,
  loadDefaults,
  loadEnv,
  logger,
  markRunStarted,
  releaseRepoLock,
  setHitlComment,
  setTaskBranch,
  setTaskPr,
  setTaskState,
  TERMINAL_STATES,
  type TaskJob,
} from "@kotx/shared";
import { ensureFreshAuth } from "./codexAuth.js";
import {
  addImplementWorktree,
  addReviewWorktree,
  commitAll,
  ensureMirrorFetched,
  mirrorPath,
  pushBranch,
  removeWorktree,
} from "./git.js";
import {
  fetchSubject,
  openOrUpdatePr,
  postFailureComment,
  postHitlComment,
  postReview,
} from "./githubOutputs.js";
import { classifyOutcome, deleteArtifacts, readArtifacts } from "./outputs.js";
import { containerName, killContainer, runCodexContainer } from "./runner.js";
import { renderTaskMd } from "./templates.js";

const RETRY_DELAY_MS = 5000;
const CANCEL_POLL_MS = 3000;

interface Guarded {
  exitCode: number;
  killedByTimeout: boolean;
  killedByCancel: boolean;
}

/** Run the container with a wall-clock kill and a cancel-flag poller (SPEC §8). */
async function runWithGuards(
  name: string,
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
  const gotLock = await acquireRepoLock(task.repo_full_name, holderId, lockTtl);
  if (!gotLock) {
    // per-repo concurrency reached; re-queue this job with a short backoff
    await enqueueTask({ ...job });
    logger.debug({ repo: task.repo_full_name }, "repo busy; requeued");
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return;
  }

  const worktreePath = run.worktree_path;
  const runOutputDir = join(env.agentDataDir, "runs", String(run.id));
  const isReview = task.kind === "review";
  const name = containerName(run.id);

  try {
    if (await isCancelled(task.id)) {
      await setTaskState(task.id, "cancelled");
      return;
    }

    await setTaskState(task.id, "running");
    await markRunStarted(run.id, name, join(runOutputDir, "codex.jsonl"));
    await mkdir(runOutputDir, { recursive: true });

    const octokit = getOctokit();
    const subject = await fetchSubject(
      octokit,
      task.repo_full_name,
      task.subject_type,
      task.subject_number,
    );

    // --- prepare the worktree (resume reuses the existing one) ---
    const token = gitToken();
    await ensureMirrorFetched(task.repo_full_name, token);

    if (job.mode === "resume") {
      // worktree already exists from the paused attempt; nothing to create
    } else if (isReview) {
      await removeWorktree(task.repo_full_name, worktreePath);
      await addReviewWorktree(
        task.repo_full_name,
        worktreePath,
        task.subject_number,
      );
    } else {
      const branch = task.branch_name ?? `agent/issue-${task.subject_number}`;
      await removeWorktree(task.repo_full_name, worktreePath);
      await addImplementWorktree(
        task.repo_full_name,
        worktreePath,
        branch,
        repo.default_branch,
      );
      await setTaskBranch(task.id, branch);
    }

    // --- render TASK.md ---
    let proposedAction: string | undefined;
    if (job.mode === "resume" && job.hitlRequestId) {
      const h = await getHitlById(job.hitlRequestId);
      proposedAction = h?.proposed_action;
    }
    const taskMd = renderTaskMd(job.mode, {
      repoFullName: task.repo_full_name,
      subjectType: task.subject_type,
      subjectNumber: task.subject_number,
      branchName: task.branch_name ?? `agent/issue-${task.subject_number}`,
      title: subject.title,
      body: subject.body,
      proposedAction,
      approvalNote: job.approvalNote,
    });
    await writeFile(join(runOutputDir, "TASK.md"), taskMd, "utf8");

    // --- run Codex ---
    await ensureFreshAuth();
    const guarded = await runWithGuards(
      name,
      worktreePath,
      runOutputDir,
      mirrorPath(task.repo_full_name),
      task.id,
    );

    // --- classify + record ---
    const artifacts = await readArtifacts(worktreePath);
    const outcome = classifyOutcome({
      exitCode: guarded.exitCode,
      artifacts,
      killedByCancel: guarded.killedByCancel,
      killedByTimeout: guarded.killedByTimeout,
    });
    await finishRun(run.id, {
      outcome,
      exitCode: guarded.exitCode,
      resultMd: artifacts.resultMd,
    });
    logger.info({ taskId: task.id, runId: run.id, outcome }, "run finished");

    // --- act on outcome ---
    if (outcome === "needs_approval" && artifacts.hitl) {
      const hitl = await createHitlRequest({
        taskId: task.id,
        taskRunId: run.id,
        reason: artifacts.hitl.reason,
        proposedAction: artifacts.hitl.proposed_action,
        risk: artifacts.hitl.risk,
        alternatives: artifacts.hitl.alternatives,
      });
      const commentId = await postHitlComment(
        octokit,
        task.repo_full_name,
        task.subject_number,
        artifacts.hitl,
        run.id,
      );
      await setHitlComment(hitl.id, commentId);
      await setTaskState(task.id, "awaiting_approval");
      // keep the worktree — the resume attempt reuses it
      return;
    }

    if (outcome === "completed" && isReview) {
      await postReview(
        octokit,
        task.repo_full_name,
        task.subject_number,
        artifacts.review ?? artifacts.resultMd ?? "_(no review produced)_",
        run.id,
      );
      await setTaskState(task.id, "done");
      await removeWorktree(task.repo_full_name, worktreePath);
      return;
    }

    if (outcome === "completed") {
      // implement / resume → commit, push, open/update PR
      const branch = task.branch_name ?? `agent/issue-${task.subject_number}`;
      const msgFile = join(runOutputDir, "COMMIT_MSG.txt");
      await writeFile(
        msgFile,
        artifacts.commitMsg ??
          `agent: changes for #${task.subject_number}\n\nAutomated by kotx (run #${run.id}).`,
        "utf8",
      );
      await deleteArtifacts(worktreePath);
      const committed = await commitAll(worktreePath, msgFile);
      if (!committed) {
        await setTaskState(task.id, "failed");
        await postFailureComment(
          octokit,
          task.repo_full_name,
          task.subject_number,
          "produced no changes",
          run.id,
        );
        await removeWorktree(task.repo_full_name, worktreePath);
        return;
      }
      await pushBranch(task.repo_full_name, branch, gitToken());
      const prNumber = await openOrUpdatePr(octokit, {
        repoFullName: task.repo_full_name,
        branch,
        base: repo.default_branch,
        issueNumber: task.subject_number,
        title: subject.title,
        resultMd: artifacts.resultMd ?? "(no summary)",
        runId: run.id,
      });
      await setTaskPr(task.id, prNumber);
      await setTaskState(task.id, "done");
      await removeWorktree(task.repo_full_name, worktreePath);
      return;
    }

    // failed / timed_out / cancelled
    const finalState =
      outcome === "timed_out"
        ? "timed_out"
        : outcome === "cancelled"
          ? "cancelled"
          : "failed";
    await setTaskState(task.id, finalState);
    if (finalState !== "cancelled") {
      await postFailureComment(
        octokit,
        task.repo_full_name,
        task.subject_number,
        finalState === "timed_out" ? "timed out" : "failed",
        run.id,
      );
    }
    await removeWorktree(task.repo_full_name, worktreePath);
  } catch (err) {
    logger.error({ err, taskId: task.id }, "job failed");
    await setTaskState(task.id, "failed").catch(() => {});
    await removeWorktree(task.repo_full_name, worktreePath).catch(() => {});
  } finally {
    await releaseRepoLock(task.repo_full_name, holderId).catch(() => {});
    await clearCancelFlag(task.id).catch(() => {});
  }
}
