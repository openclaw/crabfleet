ALTER TABLE interactive_sessions ADD COLUMN adapter TEXT;
ALTER TABLE interactive_sessions ADD COLUMN profile TEXT NOT NULL DEFAULT 'default';
ALTER TABLE interactive_sessions ADD COLUMN adapter_workspace_id TEXT;
ALTER TABLE interactive_sessions ADD COLUMN adapter_control_plane TEXT;
ALTER TABLE interactive_sessions ADD COLUMN provider_resource_id TEXT;
ALTER TABLE interactive_sessions ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE interactive_sessions ADD COLUMN expires_at INTEGER;
ALTER TABLE interactive_sessions ADD COLUMN last_reconciled_at INTEGER;
ALTER TABLE interactive_sessions ADD COLUMN reconcile_error TEXT;
ALTER TABLE interactive_sessions ADD COLUMN terminal_status TEXT;

CREATE INDEX IF NOT EXISTS idx_interactive_sessions_adapter_status
  ON interactive_sessions(adapter, status, last_reconciled_at);
