-- Up Migration

CREATE TYPE task_kind   AS ENUM ('implement', 'review');
CREATE TYPE task_state  AS ENUM (
  'queued', 'running', 'awaiting_approval',
  'done', 'failed', 'cancelled', 'timed_out'
);
CREATE TYPE run_outcome AS ENUM (
  'completed', 'needs_approval', 'failed', 'timed_out', 'cancelled'
);
CREATE TYPE hitl_state  AS ENUM ('open', 'approved', 'rejected', 'expired');

-- one logical unit of work, keyed to a GitHub issue/PR
CREATE TABLE tasks (
  id              BIGSERIAL PRIMARY KEY,
  repo_full_name  TEXT        NOT NULL,
  subject_type    TEXT        NOT NULL,            -- 'issue' | 'pull_request'
  subject_number  INTEGER     NOT NULL,
  kind            task_kind   NOT NULL,
  state           task_state  NOT NULL DEFAULT 'queued',
  branch_name     TEXT,
  pr_number       INTEGER,
  triggered_by    TEXT        NOT NULL,            -- github login
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- at most one non-terminal task per (repo, subject)
CREATE UNIQUE INDEX uq_one_active_task
  ON tasks (repo_full_name, subject_type, subject_number)
  WHERE state IN ('queued', 'running', 'awaiting_approval');

CREATE INDEX ix_tasks_state ON tasks (state);

-- keep updated_at fresh
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- one execution attempt of a task (HITL resume creates a new attempt)
CREATE TABLE task_runs (
  id              BIGSERIAL PRIMARY KEY,
  task_id         BIGINT      NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt         INTEGER     NOT NULL,
  worktree_path   TEXT        NOT NULL,
  container_name  TEXT,
  outcome         run_outcome,
  exit_code       INTEGER,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  jsonl_path      TEXT,
  result_md       TEXT,
  UNIQUE (task_id, attempt)
);

CREATE INDEX ix_task_runs_task ON task_runs (task_id);

-- webhook idempotency
CREATE TABLE github_deliveries (
  delivery_id   TEXT PRIMARY KEY,
  event         TEXT        NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- human-in-the-loop gates
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

-- at most one open HITL per task
CREATE UNIQUE INDEX uq_one_open_hitl
  ON hitl_requests (task_id)
  WHERE state = 'open';

-- Down Migration

DROP TABLE IF EXISTS hitl_requests;
DROP TABLE IF EXISTS github_deliveries;
DROP TABLE IF EXISTS task_runs;
DROP TRIGGER IF EXISTS trg_tasks_updated_at ON tasks;
DROP TABLE IF EXISTS tasks;
DROP FUNCTION IF EXISTS set_updated_at();
DROP TYPE IF EXISTS hitl_state;
DROP TYPE IF EXISTS run_outcome;
DROP TYPE IF EXISTS task_state;
DROP TYPE IF EXISTS task_kind;
