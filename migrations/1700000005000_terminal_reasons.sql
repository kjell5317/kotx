-- Up Migration

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS state_reason TEXT;

UPDATE tasks
SET state = 'failed', state_reason = COALESCE(state_reason, 'the run timed out')
WHERE state = 'timed_out';

UPDATE tasks
SET state = 'cancelled', state_reason = COALESCE(state_reason, 'discarded from the API')
WHERE state = 'discarded';

-- Down Migration

ALTER TABLE tasks DROP COLUMN IF EXISTS state_reason;
