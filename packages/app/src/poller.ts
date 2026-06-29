import {
  createTaskWithRun,
  enqueueTask,
  findActiveTask,
  getOctokit,
  LABELS,
  loadEnv,
  loadRepos,
  logger,
  parseCommand,
  recordDelivery,
  splitRepo,
  type RepoConfig,
  type SubjectType,
  type TaskKind,
} from "@kotx/shared";
import type { Octokit } from "@octokit/rest";
import { subjectFromIssue, type Normalized } from "./extract.js";
import { ingest } from "./pipeline.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_SEC ?? 30) * 1000;
// On startup (or after the cursor is lost) look back this far for commands so a
// brief app downtime doesn't drop an approval. recordDelivery dedups overlaps.
const INITIAL_LOOKBACK_MS = 60 * 60 * 1000;

// per-repo "comments since" cursor (ISO timestamp)
const commentCursor = new Map<string, string>();

/** Start polling for repos configured with `poll: true`. Returns null if none. */
export function startPoller(): NodeJS.Timeout | null {
  const repos = [...loadRepos().values()].filter((r) => r.enabled && r.poll);
  if (repos.length === 0) return null;
  logger.info(
    { repos: repos.map((r) => r.full_name), intervalMs: POLL_INTERVAL_MS },
    "polling enabled",
  );
  const tick = async () => {
    for (const repo of repos) {
      try {
        await pollRepo(repo);
      } catch (err) {
        logger.error({ err, repo: repo.full_name }, "poll failed");
      }
    }
  };
  void tick();
  return setInterval(() => void tick(), POLL_INTERVAL_MS);
}

async function pollRepo(repo: RepoConfig): Promise<void> {
  const octokit = getOctokit();
  const [owner, name] = splitRepo(repo.full_name);
  await pollLabels(octokit, owner, name, repo);
  await pollCommands(octokit, owner, name, repo);
}

function labelNames(
  labels: Array<string | { name?: string }> | undefined,
): string[] {
  if (!labels) return [];
  return labels
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter(Boolean);
}

async function pollLabels(
  octokit: Octokit,
  owner: string,
  name: string,
  repo: RepoConfig,
): Promise<void> {
  // implement: open issues (not PRs) assigned to me with agent:ready
  const ready = await octokit.issues.listForRepo({
    owner,
    repo: name,
    state: "open",
    assignee: repo.assignee_login,
    labels: LABELS.ready,
    per_page: 100,
  });
  for (const it of ready.data) {
    if (it.pull_request) continue; // implement is for issues
    if (labelNames(it.labels).includes(LABELS.ignore)) continue;
    await tryStart(octokit, owner, name, repo, "issue", it.number, "implement", LABELS.ready);
  }

  // review: open PRs assigned to me with agent:review
  const review = await octokit.issues.listForRepo({
    owner,
    repo: name,
    state: "open",
    assignee: repo.assignee_login,
    labels: LABELS.review,
    per_page: 100,
  });
  for (const it of review.data) {
    if (!it.pull_request) continue; // review is for PRs
    if (labelNames(it.labels).includes(LABELS.ignore)) continue;
    await tryStart(octokit, owner, name, repo, "pull_request", it.number, "review", LABELS.review);
  }
}

async function tryStart(
  octokit: Octokit,
  owner: string,
  name: string,
  repo: RepoConfig,
  subjectType: SubjectType,
  subjectNumber: number,
  kind: TaskKind,
  label: string,
): Promise<void> {
  const active = await findActiveTask(repo.full_name, subjectType, subjectNumber);
  if (active) return; // already running/awaiting — skip silently (no spam)

  // the worker derives the branch name (needs the issue/PR title)
  const created = await createTaskWithRun({
    repoFullName: repo.full_name,
    subjectType,
    subjectNumber,
    kind,
    branchName: null,
    triggeredBy: repo.assignee_login,
    dataDir: loadEnv().agentDataDir,
  });
  if (!created) return; // lost a race; another path created it

  await enqueueTask({
    taskId: created.task.id,
    taskRunId: created.run.id,
    mode: kind === "implement" ? "implement" : "review",
    repoFullName: repo.full_name,
    subject: { type: subjectType, number: subjectNumber },
  });

  // edge-convert: drop the trigger label so the level-triggered poll won't
  // re-enqueue. Re-add the label to run again.
  await octokit.issues
    .removeLabel({ owner, repo: name, issue_number: subjectNumber, name: label })
    .catch(() => {});
  logger.info(
    { taskId: created.task.id, repo: repo.full_name, subjectNumber, kind },
    "poll: task enqueued",
  );
}

function issueNumberFromUrl(url: string | undefined): number | null {
  if (!url) return null;
  const m = /\/issues\/(\d+)(?:$|[/?#])/.exec(url);
  return m ? Number(m[1]) : null;
}

async function pollCommands(
  octokit: Octokit,
  owner: string,
  name: string,
  repo: RepoConfig,
): Promise<void> {
  const cursor =
    commentCursor.get(repo.full_name) ??
    new Date(Date.now() - INITIAL_LOOKBACK_MS).toISOString();
  const tickStart = new Date().toISOString();

  const res = await octokit.issues.listCommentsForRepo({
    owner,
    repo: name,
    since: cursor,
    sort: "created",
    direction: "asc",
    per_page: 100,
  });

  for (const c of res.data) {
    const body = c.body ?? "";
    const cmd = parseCommand(body);
    if (!cmd) continue;
    const author = c.user?.login ?? "";
    if (author !== repo.assignee_login) continue; // only the commander

    // dedup across overlapping windows / restarts (reuses delivery table)
    const fresh = await recordDelivery(`poll-comment-${c.id}`, "issue_comment");
    if (!fresh) continue;

    const issueNumber = issueNumberFromUrl(c.issue_url);
    if (!issueNumber) continue;

    let subject;
    try {
      const issue = await octokit.issues.get({
        owner,
        repo: name,
        issue_number: issueNumber,
      });
      subject = subjectFromIssue(issue.data);
    } catch (err) {
      logger.warn({ err, issueNumber }, "poll: failed to load issue for command");
      continue;
    }

    const n: Normalized = {
      event: "issue_comment",
      action: "created",
      repoFullName: repo.full_name,
      senderLogin: author,
      subject,
      comment: { body, authorLogin: author },
    };
    const result = await ingest(n);
    logger.info(
      { repo: repo.full_name, issueNumber, cmd, result: result.status },
      "poll: command handled",
    );
  }

  commentCursor.set(repo.full_name, tickStart);
}
