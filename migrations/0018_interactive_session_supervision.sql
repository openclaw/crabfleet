ALTER TABLE interactive_sessions ADD COLUMN parent_session_id TEXT;
ALTER TABLE interactive_sessions ADD COLUMN root_session_id TEXT;
ALTER TABLE interactive_sessions ADD COLUMN created_by TEXT NOT NULL DEFAULT '';
ALTER TABLE interactive_sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT '';
ALTER TABLE interactive_sessions ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE interactive_sessions ADD COLUMN agent_token_hash TEXT;

UPDATE interactive_sessions
SET
  root_session_id = id,
  created_by = owner,
  purpose = prompt,
  summary = COALESCE(NULLIF(prompt, ''), last_event)
WHERE root_session_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_interactive_sessions_parent
  ON interactive_sessions(parent_session_id);

CREATE INDEX IF NOT EXISTS idx_interactive_sessions_root
  ON interactive_sessions(root_session_id);
