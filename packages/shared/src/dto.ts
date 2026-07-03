// The task JSON served by GET /api/tasks[/:id] AND carried in the state-change
// webhook payload. Kept in shared so both are guaranteed to be the same shape.

import {
  displayStatus,
  TERMINAL_STATES,
  type Task,
  type TaskListItem,
} from "./types.js";

export function githubUrl(
  repo: string,
  subjectType: string,
  subjectNumber: number,
): string {
  const kind = subjectType === "pull_request" ? "pull" : "issues";
  return `https://github.com/${repo}/${kind}/${subjectNumber}`;
}

/** The PR a task is effectively bound to: an opened PR (pr_number) or, for
 *  PR-subject tasks, the subject itself. */
export function trackedPrNumber(
  task: Pick<Task, "pr_number" | "subject_type" | "subject_number">,
): number | null {
  return task.pr_number ??
    (task.subject_type === "pull_request" ? task.subject_number : null);
}

export type TaskDto = ReturnType<typeof taskDto>;

export function taskDto(t: TaskListItem) {
  const inExternal = t.state === "awaiting_external";
  const trackedPr = trackedPrNumber(t);
  const hasKnownPr = trackedPr !== null;
  const mergeProposal =
    t.kind === "implement" &&
    t.state === "awaiting_approval" &&
    trackedPr !== null;
  return {
    // task ids are BIGINT → pg returns them as strings; the API contract is a number.
    id: Number(t.id),
    repo: t.repo_full_name,
    subjectType: t.subject_type,
    subjectNumber: t.subject_number,
    title: t.subject_title,
    kind: t.kind,
    role: t.role,
    state: t.state,
    status: inExternal
      ? hasKnownPr
        ? "in review"
        : "waiting on PR"
      : displayStatus(t.state),
    stateReason: t.state_reason,
    branch: t.branch_name,
    prNumber: t.pr_number,
    trackedPrNumber: trackedPr,
    triggeredBy: t.triggered_by,
    outcome: t.outcome,
    attempt: t.attempt,
    startedAt: t.started_at,
    finishedAt: t.finished_at,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    githubUrl: githubUrl(t.repo_full_name, t.subject_type, t.subject_number),
    canStart: t.kind === "implement" && t.state === "draft",
    // review → submit an approving PR review; implement (issue-origin) → open the proposed PR.
    canApprove:
      t.state === "awaiting_approval" &&
      (t.kind === "review" || t.kind === "implement"),
    canMerge: mergeProposal,
    // review tasks can also post REVIEW.md as a plain PR comment instead.
    canComment: t.kind === "review" && t.state === "awaiting_approval",
    // what approving this task does, so the UI can label the button/proposal.
    proposes:
      t.state === "awaiting_approval"
        ? t.kind === "review"
          ? "review"
          : t.kind === "implement"
            ? mergeProposal
              ? "merge"
              : "pr"
            : null
        : null,
    // any non-terminal task can be dismissed (e.g. one stuck "in review")
    canDiscard: !TERMINAL_STATES.has(t.state),
  };
}
