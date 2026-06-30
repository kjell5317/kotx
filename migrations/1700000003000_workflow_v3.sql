-- Up Migration

-- Workflow v3: role-aware, three-branch model (see SPEC §6). New task kind for
-- conflict resolution; new lifecycle states for the draft/approval gates and the
-- "pushed, waiting on others" phase. A `role` column records whether I'm the
-- assignee (I do the work) or the reviewer (I review someone else's PR).
--
-- The new enum VALUES must be committed before any later migration can USE them
-- (Postgres forbids ADD VALUE + use in the same transaction), so the index that
-- references them lives in the next migration (1700000003500).

ALTER TYPE task_kind  ADD VALUE IF NOT EXISTS 'resolve_conflict';
ALTER TYPE task_state ADD VALUE IF NOT EXISTS 'drafting';
ALTER TYPE task_state ADD VALUE IF NOT EXISTS 'draft';
ALTER TYPE task_state ADD VALUE IF NOT EXISTS 'awaiting_external';
-- 'awaiting_approval' already exists from the init migration (reused by Branch 3).

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'assignee';

-- Down Migration

ALTER TABLE tasks DROP COLUMN IF EXISTS role;

-- Note: enum VALUES added above are intentionally left in place on rollback
-- (dropping a Postgres enum value requires recreating the type; the values are
-- inert if unused).
