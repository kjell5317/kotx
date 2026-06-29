import {
  createTaskWithRun,
  enqueueTask,
  findActiveTask,
  getEnabledRepo,
  getLatestRun,
  getOctokit,
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
    await postIssueComment(getOctokit(), repoFullName, issueNumber, body);
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

  // Comment events trigger ONLY via an explicit /agent command (prevents a
  // self-loop now that comments are posted under the user's identity).
  if (n.comment) {
    const command = parseCommand(n.comment.body);
    if (!command) return { status: "ignored", reason: "no-command-on-comment" };
    if (n.comment.authorLogin !== repo.assignee_login)
      return { status: "ignored", reason: "unauthorized-commander" };
    return handleCommand(command, repo, subject, n);
  }

  // Label triggering fires only when a trigger label is ADDED.
  if (n.action !== "labeled")
    return { status: "ignored", reason: "non-trigger-action" };
  const labelIntent = intentFromLabels(subject.labels);
  if (!labelIntent || !labelIntent.kind)
    return { status: "ignored", reason: "no-trigger-label" };
  // label-triggered: no triggering comment to link to
  return startCandidate(repo, subject, labelIntent.kind, n.senderLogin, null);
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
    case "review":
      return startCandidate(
        repo,
        subject,
        kindFromCommand(command)!,
        by,
        n.comment!.htmlUrl || null,
      );
    case "stop":
      return handleStop(repo, subject);
    case "status":
      return handleStatus(repo, subject);
    default:
      return { status: "ignored", reason: "unknown-command" };
  }
}

async function startCandidate(
  repo: RepoConfig,
  subject: NormalizedSubject,
  kind: TaskKind,
  triggeredBy: string,
  triggerCommentUrl: string | null,
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
      `A task is already ${active.state} for this ${subject.type} (#${active.id}). Use \`/agent stop\` first.`,
    );
    return { status: "ignored", reason: "already-active" };
  }

  // The worker derives the branch name (it needs the issue/PR title), so leave
  // it null here.
  const created = await createTaskWithRun({
    repoFullName: repo.full_name,
    subjectType: subject.type,
    subjectNumber: subject.number,
    kind,
    branchName: null,
    triggeredBy,
    triggerCommentUrl,
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
    await comment(repo.full_name, subject.number, `Stopping #${active.id}…`);
  } else {
    await setTaskState(active.id, "cancelled");
    await comment(repo.full_name, subject.number, `Cancelled #${active.id}.`);
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
      `No active task for this ${subject.type}.`,
    );
    return { status: "handled", action: "status" };
  }
  const run = await getLatestRun(active.id);
  await comment(
    repo.full_name,
    subject.number,
    `#${active.id}: ${active.state} (${active.kind}, attempt ${run?.attempt ?? 1}).`,
  );
  return { status: "handled", action: "status" };
}
