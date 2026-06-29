-- Up Migration

-- HITL was removed: the agent now completes work autonomously. Drop the table
-- and its enum. (The unused enum VALUES awaiting_approval/needs_approval on
-- task_state/run_outcome are left in place — removing enum values requires
-- recreating the type and they're harmless.)
DROP TABLE IF EXISTS hitl_requests;
DROP TYPE IF EXISTS hitl_state;

-- Down Migration

CREATE TYPE hitl_state AS ENUM ('open', 'approved', 'rejected', 'expired');

CREATE TABLE hitl_requests (
  id              BIGSERIAL PRIMARY KEY,
  task_id         BIGINT      NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_run_id     BIGINT      NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  state           hitl_state  NOT NULL DEFAULT 'open',
  reason          TEXT        NOT NULL,
  proposed_action TEXT        NOT NULL,
  risk            TEXT        NOT NULL,
  alternatives    JSONB       NOT NULL DEFAULT '[]',
  comment_id      BIGINT,
  decided_by      TEXT,
  decided_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_one_open_hitl
  ON hitl_requests (task_id)
  WHERE state = 'open';
