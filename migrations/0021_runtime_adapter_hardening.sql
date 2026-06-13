CREATE TABLE IF NOT EXISTS id_sequences (
  name TEXT PRIMARY KEY,
  last_id INTEGER NOT NULL
);

INSERT OR IGNORE INTO id_sequences(name, last_id)
VALUES ('interactive_sessions', 100);

UPDATE id_sequences
SET last_id = MAX(
  last_id,
  COALESCE(
    (SELECT MAX(CAST(substr(id, 4) AS INTEGER)) FROM interactive_sessions WHERE id LIKE 'IS-%'),
    100
  )
)
WHERE name = 'interactive_sessions';

ALTER TABLE interactive_sessions ADD COLUMN adapter_ttl_seconds INTEGER;
ALTER TABLE interactive_sessions ADD COLUMN adapter_idle_timeout_seconds INTEGER;
ALTER TABLE interactive_sessions ADD COLUMN adapter_requested_capabilities_json TEXT;
ALTER TABLE interactive_sessions ADD COLUMN adapter_create_payload_json TEXT;
ALTER TABLE interactive_sessions ADD COLUMN adapter_create_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE interactive_sessions ADD COLUMN terminal_finalize_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE interactive_sessions ADD COLUMN terminal_failure_reason TEXT;
ALTER TABLE interactive_session_log_archives ADD COLUMN session_updated_at INTEGER;

UPDATE interactive_sessions
SET
  adapter_ttl_seconds = COALESCE(adapter_ttl_seconds, 14400),
  adapter_idle_timeout_seconds = COALESCE(adapter_idle_timeout_seconds, 1800),
  adapter_requested_capabilities_json = COALESCE(
    adapter_requested_capabilities_json,
    CASE runtime
      WHEN 'crabbox' THEN '{"terminal":true,"takeover":true,"vnc":true,"desktop":true,"logs":true,"artifacts":true}'
      ELSE '{"terminal":true,"takeover":false,"vnc":false,"desktop":false,"logs":true,"artifacts":true}'
    END
  ),
  adapter_create_payload_json = COALESCE(
    adapter_create_payload_json,
    json_object(
      'id', adapter_workspace_id,
      'parentSessionId', parent_session_id,
      'rootSessionId', COALESCE(root_session_id, id),
      'repo', repo,
      'branch', branch,
      'runtime', runtime,
      'profile', profile,
      'command', command,
      'prompt', prompt,
      'purpose', purpose,
      'summary', summary,
      'owner', owner,
      'createdBy', created_by,
      'ttlSeconds', COALESCE(adapter_ttl_seconds, 14400),
      'idleTimeoutSeconds', COALESCE(adapter_idle_timeout_seconds, 1800),
      'capabilities', json_object(
        'desktop',
        CASE runtime WHEN 'crabbox' THEN json('true') ELSE json('false') END
      )
    )
  ),
  adapter_create_pending = CASE
    WHEN status IN ('provisioning', 'pending_adapter') THEN 1
    ELSE adapter_create_pending
  END
WHERE adapter = 'runtime-v1';

UPDATE interactive_sessions
SET
  provider_resource_id = COALESCE(provider_resource_id, lease_id),
  lease_id = NULL
WHERE adapter = 'runtime-v1';

UPDATE interactive_sessions
SET
  status = 'stopping',
  terminal_status = 'failed',
  terminal_failure_reason = COALESCE(
    terminal_failure_reason,
    reconcile_error,
    last_event,
    'interactive workspace failed after release'
  )
WHERE adapter = 'runtime-v1'
  AND status = 'failed'
  AND adapter_workspace_id IS NOT NULL;

UPDATE interactive_sessions
SET terminal_finalize_pending = 1
WHERE status IN ('stopped', 'expired', 'failed');
