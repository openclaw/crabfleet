ALTER TABLE interactive_sessions ADD COLUMN openclaw_request_id TEXT;
ALTER TABLE interactive_sessions ADD COLUMN openclaw_request_hash TEXT;
ALTER TABLE interactive_sessions ADD COLUMN openclaw_admission_closed INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_interactive_sessions_openclaw_request
  ON interactive_sessions(openclaw_request_id)
  WHERE openclaw_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_interactive_sessions_openclaw_admission
  ON interactive_sessions(id, openclaw_admission_closed);
