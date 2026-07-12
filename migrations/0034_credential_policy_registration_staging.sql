CREATE TABLE IF NOT EXISTS interactive_session_credential_policy_registrations (
  session_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('registering', 'cleanup_pending')),
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
  PRIMARY KEY (session_id, sandbox_id),
  CHECK (
    (
      state = 'registering'
      AND registration_claim IS NOT NULL
      AND registration_claim_expires_at IS NOT NULL
    )
    OR (
      state = 'cleanup_pending'
      AND registration_claim IS NULL
      AND registration_claim_expires_at IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_credential_policy_registration_cleanup
  ON interactive_session_credential_policy_registrations(
    state,
    cleanup_claim_expires_at,
    last_attempt_at
  );

CREATE INDEX IF NOT EXISTS idx_credential_policy_registration_expiry
  ON interactive_session_credential_policy_registrations(
    state,
    registration_claim_expires_at,
    updated_at
  );

INSERT OR IGNORE INTO interactive_session_credential_policy_registrations (
  session_id,
  sandbox_id,
  state,
  registration_generation,
  registration_claim,
  registration_claim_expires_at,
  created_at,
  updated_at
)
SELECT
  session_id,
  sandbox_id,
  'registering',
  MIN(registration_generation),
  MIN(registration_claim),
  MIN(registration_claim_expires_at),
  MIN(created_at),
  MAX(updated_at)
FROM interactive_session_credential_policies
WHERE state = 'registering'
  AND registration_claim IS NOT NULL
  AND registration_claim_expires_at IS NOT NULL
GROUP BY session_id, sandbox_id
HAVING count(DISTINCT registration_generation) = 1
  AND count(DISTINCT registration_claim) = 1
  AND count(DISTINCT registration_claim_expires_at) = 1;
