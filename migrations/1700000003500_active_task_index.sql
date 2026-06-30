-- Up Migration

-- Redefine "active" (the single-slot-per-subject guard) to include the new
-- pre-execution states but exclude awaiting_external/terminal, so a follow-up
-- comment on an already-pushed PR can open a fresh task. Separate from the enum
-- additions in 1700000003000 because the new enum values must be committed
-- before they can be referenced in an index predicate.

DROP INDEX IF EXISTS uq_one_active_task;
CREATE UNIQUE INDEX uq_one_active_task
  ON tasks (repo_full_name, subject_type, subject_number)
  WHERE state IN ('drafting','draft','queued','running','awaiting_approval');

-- Down Migration

DROP INDEX IF EXISTS uq_one_active_task;
CREATE UNIQUE INDEX uq_one_active_task
  ON tasks (repo_full_name, subject_type, subject_number)
  WHERE state IN ('queued', 'running', 'awaiting_approval');
