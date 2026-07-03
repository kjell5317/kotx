import {
  getLatestReviewTask,
  getOctokit,
  hasAnyTask,
  hasReviewTask,
  isAgentComment,
  findTasksTrackingAnyPr,
  findTasksTrackingPr,
  loadRepos,
  logger,
  recordDelivery,
  splitRepo,
  type RepoConfig,
  type DraftFollowUpInput,
} from "@kotx/shared";
import type { Octokit } from "@octokit/rest";
import type { NormalizedSubject } from "./extract.js";
import {
  maybeResolveConflict,
  prMergeState,
  reconcileTrackedPr,
  reconcileWaitingPrs,
  startDraft,
  startReview,
} from "./pipeline.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_SEC ?? 30) * 1000;
// How often to reconcile PR lifecycle for webhook-only repos (catches missed
// pull_request opened/closed deliveries). Poll repos reconcile in their own tick.
const RECONCILE_INTERVAL_MS =
  Number(process.env.RECONCILE_INTERVAL_SEC ?? 120) * 1000;
// On startup (or after the cursor is lost) look back this far for comments so a
// brief downtime doesn't drop a follow-up. recordDelivery dedups overlaps.
const INITIAL_LOOKBACK_MS = 60 * 60 * 1000;

const commentCursor = new Map<string, string>();
const prReviewCursor = new Map<string, string>();

/**
 * Periodic PR-lifecycle reconciliation for webhook-only repos (`poll: false`).
 * Poll repos already reconcile inside their poll tick; this closes the gap where
 * a webhook repo misses a `pull_request` opened/closed delivery and would
 * otherwise leave a task stuck in `awaiting_external`. Returns null if every
 * enabled repo polls.
 */
export function startReconciler(): NodeJS.Timeout | null {
  const repos = [...loadRepos().values()].filter((r) => r.enabled && !r.poll);
  if (repos.length === 0) return null;
  logger.info(
    { repos: repos.map((r) => r.full_name), intervalMs: RECONCILE_INTERVAL_MS },
    "PR reconciler enabled",
  );
  const tick = async () => {
    for (const repo of repos) {
      try {
        await reconcileWaitingPrs(repo);
        await reconcileInReview(repo);
      } catch (err) {
        logger.error({ err, repo: repo.full_name }, "reconcile failed");
      }
    }
  };
  void tick();
  return setInterval(() => void tick(), RECONCILE_INTERVAL_MS);
}

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
  // Each step is independent — a transient GitHub failure in one must not skip
  // the rest of the tick for this repo (cursors only advance on success, so a
  // skipped step just retries next tick).
  const steps: Array<[string, () => Promise<unknown>]> = [
    ["reconcileWaitingPrs", () => reconcileWaitingPrs(repo)],
    ["reconcileInReview", () => reconcileInReview(repo)],
    ["pollIssues", () => pollIssues(octokit, owner, name, repo, me)],
    ["pollPulls", () => pollPulls(octokit, owner, name, repo, me)],
    ["pollComments", () => pollComments(octokit, owner, name, repo, me)],
    ["pollPrReviewActivity", () => pollPrReviewActivity(octokit, owner, name, repo, me)],
  ];
  for (const [step, run] of steps) {
    try {
      await run();
    } catch (err) {
      logger.warn({ err, repo: repo.full_name, step }, "poll step failed");
    }
  }
}

async function reconcileInReview(repo: RepoConfig): Promise<void> {
  const tasks = await findTasksTrackingAnyPr(repo.full_name);
  const seen = new Set<number>();
  for (const task of tasks) {
    const prNumber =
      task.pr_number ??
      (task.subject_type === "pull_request" ? task.subject_number : null);
    if (!prNumber || seen.has(prNumber)) continue;
    seen.add(prNumber);
    try {
      await reconcileTrackedPr(repo, prNumber);
    } catch (err) {
      // One PR failing to reconcile (e.g. a GitHub 5xx) must not block the rest.
      logger.warn(
        { err, repo: repo.full_name, prNumber },
        "reconcile tracked PR failed",
      );
    }
  }
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
      baseRef: pr.base?.ref,
    };
    const seen = await hasAnyTask(repo.full_name, "pull_request", pr.number);
    const headSha = pr.head?.sha ?? "";
    // GitHub drops me from requested_reviewers once I've reviewed, so a
    // re-review on new commits is keyed on an existing review task too.
    const reviewTask = await getLatestReviewTask(repo.full_name, pr.number);
    const wantsReview =
      subject.requestedReviewers.includes(me) || reviewTask !== undefined;
    if (wantsReview) {
      // Re-review when the head advances past the SHA the last review ran on
      // (stored on the task — durable across restarts, unlike an in-memory
      // cache). This is the poll-mode equivalent of the webhook `synchronize`.
      const advanced =
        reviewTask?.reviewed_head_sha != null &&
        headSha !== "" &&
        headSha !== reviewTask.reviewed_head_sha;
      if (!seen || advanced) await startReview(repo, subject, me);
    } else if (subject.assignees.includes(me)) {
      // Resolve conflicts vs. draft an implementation are mutually exclusive, and
      // both want the PR's single active slot. Decide on *settled* mergeability so
      // a not-yet-computed "unknown" doesn't let a draft steal the slot before a
      // pending conflict is detected (which would then block the resolve).
      const merge = await prMergeState(repo, pr.number);
      if (merge === "dirty") {
        await maybeResolveConflict(repo, subject, me);
      } else if (merge === "clean" && !seen) {
        // Don't re-draft a PR the agent itself opened (tracked via pr_number);
        // that assignment is the agent's own, not a request to implement.
        const tracked = await findTasksTrackingPr(repo.full_name, pr.number);
        if (tracked.length === 0) await startDraft(repo, subject, me, null);
      }
      // "unknown": mergeability still computing — do nothing this tick.
    }
  }
}

function issueNumberFromUrl(url: string | undefined): number | null {
  if (!url) return null;
  const m = /\/issues\/(\d+)(?:$|[/?#])/.exec(url);
  return m ? Number(m[1]) : null;
}

function isAtOrAfterCursor(when: string | null | undefined, cursor: string): boolean {
  if (!when) return false;
  return Date.parse(when) >= Date.parse(cursor);
}

function inlineLocation(c: {
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
}): string | undefined {
  if (!c.path) return undefined;
  return `${c.path}:${c.line ?? c.original_line ?? "?"}`;
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
    // skip the agent's own posts (marker), but let a human follow-up from the
    // same account trigger; the assignee gate below still applies.
    if (isAgentComment(c.body ?? "")) continue;
    const fresh = await recordDelivery(`poll-comment-${c.id}`, "issue_comment");
    if (!fresh) continue;

    const issueNumber = issueNumberFromUrl(c.issue_url);
    if (!issueNumber) continue;
    try {
      const issue = await octokit.issues.get({ owner, repo: name, issue_number: issueNumber });
      const it = issue.data;
      if (it.state !== "open") continue;
      const assignees = logins(it.assignees);
      // A comment on a PR I'm reviewing → re-review; otherwise a comment on a
      // subject I'm assigned to → Branch 1 follow-up.
      const iReview =
        !!it.pull_request && (await hasReviewTask(repo.full_name, it.number));
      if (!iReview && !assignees.includes(me)) continue;
      const subject: NormalizedSubject = {
        type: it.pull_request ? "pull_request" : "issue",
        number: it.number,
        state: "open",
        assignees,
        requestedReviewers: [],
        title: it.title ?? "",
        body: it.body ?? "",
      };
      if (iReview) {
        await startReview(repo, subject, author);
      } else {
        const followUpInput: DraftFollowUpInput = {
          body: c.body ?? "",
          authorLogin: author,
          htmlUrl: c.html_url ?? null,
          eventLabel: "comment",
        };
        await startDraft(repo, subject, author, c.html_url ?? null, followUpInput);
      }
    } catch (err) {
      logger.warn({ err, issueNumber }, "poll: failed to handle comment");
    }
  }

  commentCursor.set(repo.full_name, tickStart);
}

/** New PR review bodies and inline review comments on PRs assigned to me. */
async function pollPrReviewActivity(
  octokit: Octokit,
  owner: string,
  name: string,
  repo: RepoConfig,
  me: string,
): Promise<void> {
  const cursor =
    prReviewCursor.get(repo.full_name) ??
    new Date(Date.now() - INITIAL_LOOKBACK_MS).toISOString();
  const tickStart = new Date().toISOString();

  const prs = await octokit.pulls.list({
    owner,
    repo: name,
    state: "open",
    sort: "updated",
    direction: "desc",
    per_page: 100,
  });

  for (const pr of prs.data) {
    if (!isAtOrAfterCursor(pr.updated_at, cursor)) break;
    const assignees = logins(pr.assignees);
    const isAssignee = assignees.includes(me);
    // A PR I'm reviewing → new review activity re-reviews (Branch 3); a PR I'm
    // assigned to → each new review/comment is a Branch 1 follow-up.
    const iReview = await hasReviewTask(repo.full_name, pr.number);
    if (!isAssignee && !iReview) continue;
    const subject: NormalizedSubject = {
      type: "pull_request",
      number: pr.number,
      state: "open",
      assignees,
      requestedReviewers: logins(pr.requested_reviewers),
      title: pr.title ?? "",
      body: pr.body ?? "",
      headRef: pr.head?.ref,
      headRepoFullName: pr.head?.repo?.full_name ?? undefined,
      baseRef: pr.base?.ref,
    };
    // Route each fresh item: assignees get a per-item Branch 1 follow-up; for a
    // PR I'm reviewing we re-review once per tick regardless of item count.
    let reviewerActivity = false;
    const handleItem = async (
      author: string,
      htmlUrl: string | null,
      input: DraftFollowUpInput,
    ): Promise<void> => {
      if (isAssignee) await startDraft(repo, subject, author, htmlUrl, input);
      else reviewerActivity = true;
    };

    try {
      const reviews = await octokit.pulls.listReviews({
        owner,
        repo: name,
        pull_number: pr.number,
        per_page: 100,
      });
      for (const r of reviews.data) {
        if (!isAtOrAfterCursor(r.submitted_at, cursor)) continue;
        const body = r.body ?? "";
        if (isAgentComment(body)) continue;
        const fresh = await recordDelivery(`poll-pr-review-${r.id}`, "pull_request_review");
        if (!fresh) continue;
        const author = r.user?.login ?? "";
        await handleItem(author, r.html_url ?? null, {
          body,
          authorLogin: author,
          htmlUrl: r.html_url ?? null,
          eventLabel: "review",
          location: r.state ? `review: ${String(r.state).toLowerCase()}` : undefined,
        });
      }

      const inline = await octokit.pulls.listReviewComments({
        owner,
        repo: name,
        pull_number: pr.number,
        per_page: 100,
      });
      for (const c of inline.data) {
        if (!isAtOrAfterCursor(c.created_at, cursor)) continue;
        const body = c.body ?? "";
        if (isAgentComment(body)) continue;
        const fresh = await recordDelivery(
          `poll-pr-review-comment-${c.id}`,
          "pull_request_review_comment",
        );
        if (!fresh) continue;
        const author = c.user?.login ?? "";
        await handleItem(author, c.html_url ?? null, {
          body,
          authorLogin: author,
          htmlUrl: c.html_url ?? null,
          eventLabel: "inline review comment",
          location: inlineLocation(c),
        });
      }

      if (reviewerActivity) await startReview(repo, subject, me);
    } catch (err) {
      logger.warn({ err, prNumber: pr.number }, "poll: failed to handle PR review activity");
    }
  }

  prReviewCursor.set(repo.full_name, tickStart);
}
