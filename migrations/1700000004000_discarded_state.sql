-- Up Migration

-- A terminal state for tasks dismissed from the frontend (POST /api/tasks/:id/
-- discard). Like the other terminal states it's excluded from the "active" list
-- and from the active-slot unique index, so discarding frees the subject.
ALTER TYPE task_state ADD VALUE IF NOT EXISTS 'discarded';

-- Down Migration

-- Enum values can't be dropped without recreating the type; left in place
-- (inert if unused). No-op.
