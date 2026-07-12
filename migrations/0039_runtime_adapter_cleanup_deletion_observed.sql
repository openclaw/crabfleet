ALTER TABLE runtime_adapter_workspace_cleanups
  ADD COLUMN deletion_observed INTEGER NOT NULL DEFAULT 0
  CHECK (deletion_observed IN (0, 1));
