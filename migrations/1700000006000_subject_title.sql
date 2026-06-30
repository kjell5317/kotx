-- Up Migration

-- GitHub issue/PR title at task-creation time, so the API/frontend can show a
-- human-readable label without a live GitHub fetch per task. Nullable: pre-existing
-- rows have no captured title.
ALTER TABLE tasks ADD COLUMN subject_title TEXT;

-- Down Migration

ALTER TABLE tasks DROP COLUMN subject_title;
