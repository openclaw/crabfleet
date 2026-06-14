ALTER TABLE interactive_sessions ADD COLUMN openclaw_request_id TEXT;
ALTER TABLE interactive_sessions ADD COLUMN openclaw_request_hash TEXT;
ALTER TABLE interactive_sessions ADD COLUMN openclaw_admission_closed INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_interactive_sessions_openclaw_request
  ON interactive_sessions(openclaw_request_id)
  WHERE openclaw_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_interactive_sessions_openclaw_admission
  ON interactive_sessions(id, openclaw_admission_closed);

CREATE TABLE IF NOT EXISTS openclaw_request_replays (
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_openclaw_request_replays_session
  ON openclaw_request_replays(session_id);
