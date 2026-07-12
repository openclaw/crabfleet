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

-- Once a new worker stages a rotation, legacy workers must not claim, promote,
-- or remove the policy rows underneath its rollback snapshot. Cleanup may
-- still transition an older generation into cleanup_pending, but its rows stay
-- fenced until the staged registration is removed.
CREATE TRIGGER IF NOT EXISTS fence_staged_credential_policy_insert
BEFORE INSERT ON interactive_session_credential_policies
WHEN NEW.state != 'cleanup_pending'
  AND EXISTS (
    SELECT 1
    FROM interactive_session_credential_policy_registrations AS staged
    WHERE staged.session_id = NEW.session_id
      AND staged.sandbox_id = NEW.sandbox_id
      AND staged.registration_generation != NEW.registration_generation
  )
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER IF NOT EXISTS fence_staged_credential_policy_update
BEFORE UPDATE ON interactive_session_credential_policies
WHEN NOT (OLD.state != 'cleanup_pending' AND NEW.state = 'cleanup_pending')
  AND EXISTS (
    SELECT 1
    FROM interactive_session_credential_policy_registrations AS staged
    WHERE staged.session_id = NEW.session_id
      AND staged.sandbox_id = NEW.sandbox_id
      AND staged.registration_generation != NEW.registration_generation
  )
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER IF NOT EXISTS fence_staged_credential_policy_delete
BEFORE DELETE ON interactive_session_credential_policies
WHEN EXISTS (
  SELECT 1
  FROM interactive_session_credential_policy_registrations AS staged
  WHERE staged.session_id = OLD.session_id
    AND staged.sandbox_id = OLD.sandbox_id
)
BEGIN
  SELECT RAISE(IGNORE);
END;

-- Legacy workers renew registration claims only in the policy table. Leaving
-- those claims unstaged prevents the new scanner from recovering a stale
-- snapshot while the legacy registration is still live.
