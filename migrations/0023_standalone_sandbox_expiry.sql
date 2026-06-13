ALTER TABLE standalone_sandbox_provisions ADD COLUMN expires_at INTEGER;

UPDATE standalone_sandbox_provisions
SET expires_at = CASE
  WHEN lower(id) GLOB 'is-[0-9]*'
    AND substr(lower(id), 4) NOT GLOB '*[^0-9]*'
  THEN 0
  ELSE created_at + 14400000
END
WHERE state IN ('provisioning', 'active');

UPDATE id_sequences
SET last_id = MAX(
  last_id,
  COALESCE(
    (
      SELECT MAX(CAST(substr(lower(id), 4) AS INTEGER))
      FROM standalone_sandbox_provisions
      WHERE lower(id) GLOB 'is-[0-9]*'
        AND substr(lower(id), 4) NOT GLOB '*[^0-9]*'
    ),
    100
  )
)
WHERE name = 'interactive_sessions';

CREATE INDEX IF NOT EXISTS idx_standalone_sandbox_provision_expiry
  ON standalone_sandbox_provisions(state, expires_at, updated_at);
