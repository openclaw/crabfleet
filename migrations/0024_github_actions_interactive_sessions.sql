ALTER TABLE interactive_sessions ADD COLUMN work_key TEXT;
ALTER TABLE interactive_sessions ADD COLUMN work_kind TEXT;
ALTER TABLE interactive_sessions ADD COLUMN work_state TEXT NOT NULL DEFAULT '';
ALTER TABLE interactive_sessions ADD COLUMN work_phase TEXT NOT NULL DEFAULT '';
ALTER TABLE interactive_sessions ADD COLUMN source_url TEXT;
ALTER TABLE interactive_sessions ADD COLUMN github_run_url TEXT;
ALTER TABLE interactive_sessions ADD COLUMN codex_thread_id TEXT;
ALTER TABLE interactive_sessions ADD COLUMN codex_turn_id TEXT;
ALTER TABLE interactive_sessions ADD COLUMN last_heartbeat_at INTEGER;
ALTER TABLE interactive_sessions ADD COLUMN completion_reason TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_interactive_sessions_work_key
  ON interactive_sessions(work_key)
  WHERE work_key IS NOT NULL AND work_key != '';

CREATE INDEX IF NOT EXISTS idx_interactive_sessions_work_state
  ON interactive_sessions(work_state, updated_at)
  WHERE work_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_interactive_sessions_work_heartbeat
  ON interactive_sessions(last_heartbeat_at)
  WHERE work_key IS NOT NULL;
