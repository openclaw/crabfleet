ALTER TABLE interactive_session_events ADD COLUMN event_key TEXT;
ALTER TABLE interactive_session_events
  ADD COLUMN event_type TEXT NOT NULL DEFAULT 'message';
ALTER TABLE interactive_session_events ADD COLUMN payload_json TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_interactive_session_events_session_event_key
  ON interactive_session_events(session_id, event_key)
  WHERE event_key IS NOT NULL AND event_key <> '';

CREATE TRIGGER IF NOT EXISTS enforce_interactive_session_action_event_budget
BEFORE INSERT ON interactive_session_events
WHEN NEW.event_key IS NOT NULL
  AND NEW.event_key <> ''
  AND NOT EXISTS (
    SELECT 1
    FROM interactive_session_events
    WHERE session_id = NEW.session_id
      AND event_key = NEW.event_key
  )
  AND (
    (
      SELECT COUNT(*)
      FROM interactive_session_events
      WHERE session_id = NEW.session_id
        AND event_key IS NOT NULL
        AND event_key <> ''
    ) >= 2048
    OR (
      SELECT COALESCE(
        SUM(
          length(CAST(actor AS BLOB))
          + length(CAST(event_key AS BLOB))
          + length(CAST(event_type AS BLOB))
          + length(CAST(message AS BLOB))
          + length(CAST(COALESCE(payload_json, '') AS BLOB))
        ),
        0
      )
      FROM interactive_session_events
      WHERE session_id = NEW.session_id
        AND event_key IS NOT NULL
        AND event_key <> ''
    )
      + length(CAST(NEW.actor AS BLOB))
      + length(CAST(NEW.event_key AS BLOB))
      + length(CAST(NEW.event_type AS BLOB))
      + length(CAST(NEW.message AS BLOB))
      + length(CAST(COALESCE(NEW.payload_json, '') AS BLOB))
      > 8388608
  )
BEGIN
  SELECT RAISE(ABORT, 'structured session event budget exceeded');
END;
