-- Up Migration

-- Human-readable description of what triggered a task's creation or last refresh
-- (e.g. "review requested", "new commits on PR", "new comment on PR", "manual
-- run"). Surfaced in the API/webhook so the frontend can explain why a task
-- appeared. NULL for rows created before this migration.
ALTER TABLE tasks ADD COLUMN trigger_reason TEXT;

-- The resolved "owners" of the task's subject: the GitHub issue/PR assignee
-- logins, or the PR author's login when a PR has no assignee. Captured at task
-- creation and refreshed on later triggers so the frontend can show who owns a
-- reviewed PR without a live GitHub fetch. NULL for rows created before this
-- migration; an empty array means "no owner could be resolved".
ALTER TABLE tasks ADD COLUMN subject_assignees TEXT[];

-- Down Migration

ALTER TABLE tasks DROP COLUMN subject_assignees;
ALTER TABLE tasks DROP COLUMN trigger_reason;
