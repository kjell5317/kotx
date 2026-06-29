import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireRepoLock,
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
  releaseRepoLock,
  setTaskBranch,
  setTaskState,
  TERMINAL_STATES,
  type Task,
  type TaskJob,
} from "@kotx/shared";
import { ensureFreshAuth } from "./codexAuth.js";
import {
  addImplementWorktree,
  commitAll,
  ensureMirrorFetched,
  issueBranchName,
  mirrorPath,
  pushBranch,
  removeWorktree,
} from "./git.js";
import {
  fetchSubject,
  postFailureComment,
  postSummary,
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

function defaultCommitMsg(task: Task): string {
  return `Changes for #${task.subject_number}\n`;
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

    // Decide the branch to work on + where to start it from.
    //  - issue  → a fresh GitHub-style branch off the default branch
    //  - PR     → the PR's own head branch (so pushes update the PR)
    let branch: string;
    let startRef: string;
    if (isReview) {
      if (!subject.headRef) throw new Error("PR has no head ref");
      if (
        subject.headRepoFullName &&
        subject.headRepoFullName !== task.repo_full_name
      ) {
        await finishRun(run.id, {
          outcome: "failed",
          exitCode: null,
          resultMd: null,
        });
        await setTaskState(task.id, "failed");
        await postFailureComment(
          octokit,
          task.repo_full_name,
          task.subject_number,
          "this PR comes from a fork, so its branch can't be pushed to",
        );
        return;
      }
      branch = subject.headRef;
      startRef = subject.headRef;
    } else {
      branch = issueBranchName(task.subject_number, subject.title);
      startRef = repo.default_branch;
    }
    await setTaskBranch(task.id, branch);

    const token = gitToken();
    await ensureMirrorFetched(task.repo_full_name, token);
    await removeWorktree(task.repo_full_name, worktreePath);
    await addImplementWorktree(
      task.repo_full_name,
      worktreePath,
      branch,
      startRef,
    );

    const taskMd = renderTaskMd(job.mode, {
      repoFullName: task.repo_full_name,
      subjectType: task.subject_type,
      subjectNumber: task.subject_number,
      branchName: branch,
      title: subject.title,
      body: subject.body,
    });
    await writeFile(join(runOutputDir, "TASK.md"), taskMd, "utf8");

    await ensureFreshAuth();
    const guarded = await runWithGuards(
      name,
      worktreePath,
      runOutputDir,
      mirrorPath(task.repo_full_name),
      task.id,
    );

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

    if (outcome === "completed") {
      // commit + push the branch (if there are changes), then post a summary.
      // No PR is ever opened.
      const msgFile = join(runOutputDir, "COMMIT_MSG.txt");
      await writeFile(
        msgFile,
        artifacts.commitMsg ?? defaultCommitMsg(task),
        "utf8",
      );
      await deleteArtifacts(worktreePath);
      const committed = await commitAll(worktreePath, msgFile);
      if (committed) await pushBranch(task.repo_full_name, branch, gitToken());

      const summary = artifacts.resultMd ?? "Done.";
      const body =
        !isReview && committed
          ? `${summary}\n\nChanges pushed to \`${branch}\`.`
          : summary;
      await postSummary(octokit, task.repo_full_name, task.subject_number, body);
      await setTaskState(task.id, "done");
      await removeWorktree(task.repo_full_name, worktreePath);
      return;
    }

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
        finalState === "timed_out" ? "the run timed out" : "the run failed",
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
