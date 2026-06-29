-- Up Migration

-- URL of the comment that triggered the task (for command-triggered tasks).
-- Used to deep-link notifications to the exact triggering comment on PRs.
ALTER TABLE tasks ADD COLUMN trigger_comment_url TEXT;

-- Down Migration

ALTER TABLE tasks DROP COLUMN trigger_comment_url;
