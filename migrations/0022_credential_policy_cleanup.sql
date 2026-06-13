ALTER TABLE interactive_sessions ADD COLUMN credential_cleanup_terminal_status TEXT
  CHECK (
    credential_cleanup_terminal_status IS NULL
    OR credential_cleanup_terminal_status IN ('stopped', 'expired', 'failed')
  );

ALTER TABLE interactive_sessions ADD COLUMN sandbox_refresh_sandbox_id TEXT;
ALTER TABLE interactive_sessions ADD COLUMN sandbox_refresh_claim TEXT;
ALTER TABLE interactive_sessions ADD COLUMN sandbox_refresh_claim_expires_at INTEGER;

CREATE TABLE IF NOT EXISTS standalone_sandbox_provisions (
  id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  sandbox_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('provisioning', 'active', 'cleanup_pending')),
  ownership_claim TEXT,
  ownership_claim_expires_at INTEGER,
  lease_id TEXT,
  attach_url TEXT,
  vnc_url TEXT,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (ownership_claim IS NULL AND ownership_claim_expires_at IS NULL)
    OR (ownership_claim IS NOT NULL AND ownership_claim_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_standalone_sandbox_provision_state
  ON standalone_sandbox_provisions(state, ownership_claim_expires_at, updated_at);

CREATE TABLE IF NOT EXISTS interactive_session_credential_policies (
  session_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  lookup_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('registering', 'active', 'cleanup_pending')),
  registration_generation TEXT NOT NULL,
  registration_claim TEXT,
  registration_claim_expires_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  last_error TEXT,
  cleanup_claim TEXT,
  cleanup_claim_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, sandbox_id, lookup_id),
  CHECK (
    (registration_claim IS NULL AND registration_claim_expires_at IS NULL)
    OR (registration_claim IS NOT NULL AND registration_claim_expires_at IS NOT NULL)
  ),
  CHECK (
    registration_claim IS NULL
    OR state IN ('registering', 'cleanup_pending')
  )
);

CREATE INDEX IF NOT EXISTS idx_interactive_policy_cleanup
  ON interactive_session_credential_policies(state, cleanup_claim_expires_at, last_attempt_at);

CREATE INDEX IF NOT EXISTS idx_interactive_policy_session
  ON interactive_session_credential_policies(session_id, state);

CREATE INDEX IF NOT EXISTS idx_interactive_policy_registration
  ON interactive_session_credential_policies(state, registration_claim_expires_at);

CREATE INDEX IF NOT EXISTS idx_interactive_policy_cleanup_groups
  ON interactive_session_credential_policies(state, session_id, sandbox_id);

CREATE INDEX IF NOT EXISTS idx_interactive_policy_fair_cleanup
  ON interactive_session_credential_policies(
    state,
    COALESCE(last_attempt_at, created_at),
    session_id,
    sandbox_id,
    lookup_id
  );

CREATE INDEX IF NOT EXISTS idx_interactive_session_credential_completion
  ON interactive_sessions(status, credential_cleanup_terminal_status, stopped_at, id);

CREATE TABLE IF NOT EXISTS credential_policy_reconcile_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_rowid INTEGER NOT NULL DEFAULT 0,
  scan_max_rowid INTEGER NOT NULL DEFAULT 0,
  group_session_id TEXT NOT NULL DEFAULT '',
  group_sandbox_id TEXT NOT NULL DEFAULT '',
  group_max_session_id TEXT NOT NULL DEFAULT '',
  group_max_sandbox_id TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO credential_policy_reconcile_state (
  id,
  last_rowid,
  scan_max_rowid,
  group_session_id,
  group_sandbox_id,
  group_max_session_id,
  group_max_sandbox_id,
  updated_at
)
VALUES (1, 0, 0, '', '', '', '', 0);

INSERT OR IGNORE INTO interactive_session_credential_policies (
  session_id,
  sandbox_id,
  lookup_id,
  state,
  registration_generation,
  registration_claim,
  registration_claim_expires_at,
  created_at,
  updated_at
)
SELECT
  id,
  CASE
    WHEN instr(substr(lease_id, 9), ':') > 0
      THEN substr(lease_id, 9, instr(substr(lease_id, 9), ':') - 1)
    ELSE substr(lease_id, 9)
  END,
  CASE
    WHEN instr(substr(lease_id, 9), ':') > 0
      THEN substr(lease_id, 9, instr(substr(lease_id, 9), ':') - 1)
    ELSE substr(lease_id, 9)
  END,
  CASE
    WHEN status IN ('stopping', 'stopped', 'expired', 'failed') THEN 'cleanup_pending'
    ELSE 'active'
  END,
  'legacy:' || id || ':' || CASE
    WHEN instr(substr(lease_id, 9), ':') > 0
      THEN substr(lease_id, 9, instr(substr(lease_id, 9), ':') - 1)
    ELSE substr(lease_id, 9)
  END,
  NULL,
  NULL,
  COALESCE(updated_at, 0),
  COALESCE(updated_at, 0)
FROM interactive_sessions
WHERE (adapter IS NULL OR adapter != 'runtime-v1')
  AND lease_id LIKE 'sandbox:%';

UPDATE interactive_sessions
SET
  status = 'stopping',
  credential_cleanup_terminal_status = CASE
    WHEN status = 'stopping' THEN 'stopped'
    WHEN status IN ('stopped', 'expired', 'failed') THEN status
    ELSE credential_cleanup_terminal_status
  END,
  terminal_failure_reason = CASE
    WHEN status = 'failed' THEN COALESCE(
      NULLIF(terminal_failure_reason, ''),
      NULLIF(reconcile_error, ''),
      NULLIF(last_event, ''),
      'interactive workspace failed during credential cleanup'
    )
    ELSE terminal_failure_reason
  END,
  terminal_finalize_pending = 0,
  agent_token_hash = NULL,
  attach_url = NULL,
  vnc_url = NULL,
  controller = NULL,
  control_requested_by = NULL,
  control_requested_at = NULL,
  control_granted_at = NULL,
  control_expires_at = NULL
WHERE (adapter IS NULL OR adapter != 'runtime-v1')
  AND lease_id LIKE 'sandbox:%'
  AND status IN ('stopping', 'stopped', 'expired', 'failed');
