ALTER TABLE interactive_session_events ADD COLUMN event_key TEXT;
ALTER TABLE interactive_session_events
  ADD COLUMN event_type TEXT NOT NULL DEFAULT 'message';
ALTER TABLE interactive_session_events ADD COLUMN payload_json TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_interactive_session_events_session_event_key
  ON interactive_session_events(session_id, event_key)
  WHERE event_key IS NOT NULL AND event_key <> '';
