-- Up Migration

-- The PR head commit SHA a review run was performed against. The poller compares
-- the current PR head to this to decide whether new commits warrant a re-review
-- (the durable equivalent of the webhook `synchronize` signal). NULL until a
-- review run for the task completes.
ALTER TABLE tasks ADD COLUMN reviewed_head_sha TEXT;

-- Down Migration

ALTER TABLE tasks DROP COLUMN reviewed_head_sha;
