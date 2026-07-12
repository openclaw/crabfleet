CREATE TABLE IF NOT EXISTS runtime_adapter_workspace_cleanups (
  session_id TEXT NOT NULL,
  adapter_workspace_id TEXT NOT NULL,
  profile TEXT,
  control_plane TEXT,
  create_pending INTEGER NOT NULL CHECK (create_pending IN (0, 1)),
  message TEXT NOT NULL,
  reconcile_error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  next_attempt_at INTEGER NOT NULL,
  cleanup_claim TEXT,
  cleanup_claim_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, adapter_workspace_id),
  CHECK (
    (cleanup_claim IS NULL AND cleanup_claim_expires_at IS NULL)
    OR (cleanup_claim IS NOT NULL AND cleanup_claim_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_runtime_adapter_workspace_cleanup_due
  ON runtime_adapter_workspace_cleanups(
    next_attempt_at,
    cleanup_claim_expires_at,
    updated_at,
    session_id,
    adapter_workspace_id
  );
