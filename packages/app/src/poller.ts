import {
  getOctokit,
  hasAnyTask,
  loadRepos,
  logger,
  recordDelivery,
  splitRepo,
  type RepoConfig,
} from "@kotx/shared";
import type { Octokit } from "@octokit/rest";
import type { NormalizedSubject } from "./extract.js";
import { maybeResolveConflict, startDraft, startReview } from "./pipeline.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_SEC ?? 30) * 1000;
// On startup (or after the cursor is lost) look back this far for comments so a
// brief downtime doesn't drop a follow-up. recordDelivery dedups overlaps.
const INITIAL_LOOKBACK_MS = 60 * 60 * 1000;

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
  const me = repo.assignee_login;
  await pollIssues(octokit, owner, name, repo, me);
  await pollPulls(octokit, owner, name, repo, me);
  await pollComments(octokit, owner, name, repo, me);
}

function logins(
  arr: Array<{ login?: string } | null> | null | undefined,
): string[] {
  return (arr ?? [])
    .map((x) => x?.login)
    .filter((l): l is string => !!l);
}

/** Open issues assigned to me → draft (Branch 1). startDraft no-ops if active. */
async function pollIssues(
  octokit: Octokit,
  owner: string,
  name: string,
  repo: RepoConfig,
  me: string,
): Promise<void> {
  const res = await octokit.issues.listForRepo({
    owner,
    repo: name,
    state: "open",
    assignee: me,
    per_page: 100,
  });
  for (const it of res.data) {
    if (it.pull_request) continue; // PRs handled by pollPulls
    // fire assignment-draft once per subject; follow-ups come via pollComments
    if (await hasAnyTask(repo.full_name, "issue", it.number)) continue;
    const subject: NormalizedSubject = {
      type: "issue",
      number: it.number,
      state: "open",
      assignees: logins(it.assignees),
      requestedReviewers: [],
      title: it.title ?? "",
      body: it.body ?? "",
    };
    await startDraft(repo, subject, me, null);
  }
}

/** Open PRs: review requests (Branch 3), conflicts + drafts for mine (Branch 1/2). */
async function pollPulls(
  octokit: Octokit,
  owner: string,
  name: string,
  repo: RepoConfig,
  me: string,
): Promise<void> {
  const res = await octokit.pulls.list({
    owner,
    repo: name,
    state: "open",
    per_page: 100,
  });
  for (const pr of res.data) {
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
    };
    const seen = await hasAnyTask(repo.full_name, "pull_request", pr.number);
    if (subject.requestedReviewers.includes(me)) {
      // review once per subject via poll (re-review on new commits needs webhooks)
      if (!seen) await startReview(repo, subject, me);
    } else if (subject.assignees.includes(me)) {
      // conflict check is self-limiting (only fires when dirty + no active task)
      await maybeResolveConflict(repo, subject, me);
      if (!seen) await startDraft(repo, subject, me, null);
    }
  }
}

function issueNumberFromUrl(url: string | undefined): number | null {
  if (!url) return null;
  const m = /\/issues\/(\d+)(?:$|[/?#])/.exec(url);
  return m ? Number(m[1]) : null;
}

/** New comments by others on subjects assigned to me → follow-up draft. */
async function pollComments(
  octokit: Octokit,
  owner: string,
  name: string,
  repo: RepoConfig,
  me: string,
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
    const author = c.user?.login ?? "";
    if (author === me) continue; // skip my own comments (avoid self-loop)
    const fresh = await recordDelivery(`poll-comment-${c.id}`, "issue_comment");
    if (!fresh) continue;

    const issueNumber = issueNumberFromUrl(c.issue_url);
    if (!issueNumber) continue;
    try {
      const issue = await octokit.issues.get({ owner, repo: name, issue_number: issueNumber });
      const it = issue.data;
      if (it.state !== "open") continue;
      const assignees = logins(it.assignees);
      if (!assignees.includes(me)) continue;
      const subject: NormalizedSubject = {
        type: it.pull_request ? "pull_request" : "issue",
        number: it.number,
        state: "open",
        assignees,
        requestedReviewers: [],
        title: it.title ?? "",
        body: it.body ?? "",
      };
      await startDraft(repo, subject, author, c.html_url ?? null);
    } catch (err) {
      logger.warn({ err, issueNumber }, "poll: failed to handle comment");
    }
  }

  commentCursor.set(repo.full_name, tickStart);
}
