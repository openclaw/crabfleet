ALTER TABLE interactive_sessions ADD COLUMN preparation_pending INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_interactive_sessions_preparation
  ON interactive_sessions(preparation_pending, updated_at);
