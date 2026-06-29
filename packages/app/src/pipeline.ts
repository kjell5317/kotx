import {
  createNextRun,
  createTaskWithRun,
  decideHitl,
  enqueueTask,
  findActiveTask,
  getEnabledRepo,
  getOctokit,
  getLatestRun,
  getOpenHitlForTask,
  hasIgnoreLabel,
  intentFromLabels,
  kindFromCommand,
  loadEnv,
  logger,
  parseCommand,
  postIssueComment,
  setCancelFlag,
  setTaskState,
  type AgentCommand,
  type RepoConfig,
  type TaskKind,
} from "@kotx/shared";
import type { Normalized, NormalizedSubject } from "./extract.js";

export type IngestResult =
  | { status: "ignored"; reason: string }
  | { status: "handled"; action: string }
  | { status: "enqueued"; taskId: number };

async function comment(
  repoFullName: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  try {
    const octokit = getOctokit();
    await postIssueComment(octokit, repoFullName, issueNumber, body);
  } catch (err) {
    logger.warn({ err, repoFullName, issueNumber }, "failed to post comment");
  }
}

export async function ingest(n: Normalized): Promise<IngestResult> {
  const repo = getEnabledRepo(n.repoFullName);
  if (!repo) return { status: "ignored", reason: "repo-not-enabled" };
  if (!n.subject) return { status: "ignored", reason: "no-subject" };
  const subject = n.subject;

  if (hasIgnoreLabel(subject.labels))
    return { status: "ignored", reason: "agent:ignore" };

  // Comment events trigger ONLY via an explicit /agent command. This prevents a
  // self-loop now that the agent comments as the user (PAT identity): the
  // agent's own comments aren't commands, so they're ignored here.
  if (n.comment) {
    const command = parseCommand(n.comment.body);
    if (!command) return { status: "ignored", reason: "no-command-on-comment" };
    // commands are honored ONLY from the single authorized commander (SPEC §6.3)
    if (n.comment.authorLogin !== repo.assignee_login)
      return { status: "ignored", reason: "unauthorized-commander" };
    return handleCommand(command, repo, subject, n);
  }

  // Label-driven triggering fires only when a trigger label is ADDED, not on
  // every issue/PR edit, so unrelated activity can't re-launch a run.
  if (n.action !== "labeled")
    return { status: "ignored", reason: "non-trigger-action" };
  const labelIntent = intentFromLabels(subject.labels);
  if (!labelIntent || !labelIntent.kind)
    return { status: "ignored", reason: "no-trigger-label" };
  return startCandidate(repo, subject, labelIntent.kind, n.senderLogin);
}

async function handleCommand(
  command: AgentCommand,
  repo: RepoConfig,
  subject: NormalizedSubject,
  n: Normalized,
): Promise<IngestResult> {
  const by = n.comment!.authorLogin;
  switch (command) {
    case "run":
    case "review": {
      const kind = kindFromCommand(command)!;
      return startCandidate(repo, subject, kind, by);
    }
    case "stop":
      return handleStop(repo, subject);
    case "status":
      return handleStatus(repo, subject);
    case "approve":
    case "reject":
      return handleDecision(command, repo, subject, n);
    default:
      return { status: "ignored", reason: "unknown-command" };
  }
}

async function startCandidate(
  repo: RepoConfig,
  subject: NormalizedSubject,
  kind: TaskKind,
  triggeredBy: string,
): Promise<IngestResult> {
  if (subject.state !== "open")
    return { status: "ignored", reason: "subject-closed" };
  if (!subject.assignees.includes(repo.assignee_login))
    return { status: "ignored", reason: "not-assigned" };

  const active = await findActiveTask(
    repo.full_name,
    subject.type,
    subject.number,
  );
  if (active) {
    await comment(
      repo.full_name,
      subject.number,
      `🤖 A task is already ${active.state} for this ${subject.type} (task #${active.id}). Use \`/agent stop\` first.`,
    );
    return { status: "ignored", reason: "already-active" };
  }

  const branchName =
    kind === "implement" ? `agent/issue-${subject.number}` : null;

  const created = await createTaskWithRun({
    repoFullName: repo.full_name,
    subjectType: subject.type,
    subjectNumber: subject.number,
    kind,
    branchName,
    triggeredBy,
    dataDir: loadEnv().agentDataDir,
  });
  if (!created) return { status: "ignored", reason: "already-active-race" };

  await enqueueTask({
    taskId: created.task.id,
    taskRunId: created.run.id,
    mode: kind === "implement" ? "implement" : "review",
    repoFullName: repo.full_name,
    subject: { type: subject.type, number: subject.number },
  });
  logger.info(
    { taskId: created.task.id, kind, repo: repo.full_name },
    "task enqueued",
  );
  return { status: "enqueued", taskId: created.task.id };
}

async function handleStop(
  repo: RepoConfig,
  subject: NormalizedSubject,
): Promise<IngestResult> {
  const active = await findActiveTask(
    repo.full_name,
    subject.type,
    subject.number,
  );
  if (!active) return { status: "ignored", reason: "no-active-task" };

  await setCancelFlag(active.id);
  if (active.state === "running") {
    // worker observes the cancel flag, kills the container, sets 'cancelled'
    await comment(repo.full_name, subject.number, `🤖 Stopping task #${active.id}…`);
  } else {
    // queued or awaiting_approval — cancel directly
    const open = await getOpenHitlForTask(active.id);
    if (open) await decideHitl(open.id, "rejected", null);
    await setTaskState(active.id, "cancelled");
    await comment(
      repo.full_name,
      subject.number,
      `🤖 Cancelled task #${active.id}.`,
    );
  }
  return { status: "handled", action: "stop" };
}

async function handleStatus(
  repo: RepoConfig,
  subject: NormalizedSubject,
): Promise<IngestResult> {
  const active = await findActiveTask(
    repo.full_name,
    subject.type,
    subject.number,
  );
  if (!active) {
    await comment(
      repo.full_name,
      subject.number,
      `🤖 No active task for this ${subject.type}.`,
    );
    return { status: "handled", action: "status" };
  }
  const run = await getLatestRun(active.id);
  const prLink = active.pr_number ? ` · PR #${active.pr_number}` : "";
  await comment(
    repo.full_name,
    subject.number,
    `🤖 Task #${active.id}: **${active.state}** (${active.kind}, attempt ${run?.attempt ?? 1})${prLink}.`,
  );
  return { status: "handled", action: "status" };
}

async function handleDecision(
  command: "approve" | "reject",
  repo: RepoConfig,
  subject: NormalizedSubject,
  n: Normalized,
): Promise<IngestResult> {
  const active = await findActiveTask(
    repo.full_name,
    subject.type,
    subject.number,
  );
  if (!active || active.state !== "awaiting_approval") {
    await comment(
      repo.full_name,
      subject.number,
      `🤖 No pending approval to ${command}.`,
    );
    return { status: "ignored", reason: "no-open-hitl" };
  }
  const open = await getOpenHitlForTask(active.id);
  if (!open) {
    await comment(
      repo.full_name,
      subject.number,
      `🤖 No pending approval to ${command}.`,
    );
    return { status: "ignored", reason: "no-open-hitl" };
  }

  const by = n.comment!.authorLogin;
  if (command === "reject") {
    await decideHitl(open.id, "rejected", by);
    await setTaskState(active.id, "cancelled");
    await comment(
      repo.full_name,
      subject.number,
      `🤖 Rejected. Task #${active.id} cancelled.`,
    );
    return { status: "handled", action: "reject" };
  }

  // approve → new attempt reusing the same worktree, resume job enqueued
  await decideHitl(open.id, "approved", by);
  const latest = await getLatestRun(active.id);
  const worktreePath = latest?.worktree_path ?? "";
  const next = await createNextRun(active.id, worktreePath);
  await enqueueTask({
    taskId: active.id,
    taskRunId: next.id,
    mode: "resume",
    repoFullName: repo.full_name,
    subject: { type: subject.type, number: subject.number },
    hitlRequestId: open.id,
    approvalNote: n.comment!.body,
  });
  await comment(
    repo.full_name,
    subject.number,
    `🤖 Approved. Resuming task #${active.id} (attempt ${next.attempt})…`,
  );
  return { status: "handled", action: "approve" };
}
