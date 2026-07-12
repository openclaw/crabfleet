ALTER TABLE interactive_session_credential_policy_registrations
  ADD COLUMN repair_generation TEXT;

DROP TRIGGER IF EXISTS fence_staged_credential_policy_insert;
DROP TRIGGER IF EXISTS fence_staged_credential_policy_update;

CREATE TRIGGER fence_staged_credential_policy_insert
BEFORE INSERT ON interactive_session_credential_policies
WHEN NEW.state != 'cleanup_pending'
  AND EXISTS (
    SELECT 1
    FROM interactive_session_credential_policy_registrations AS staged
    WHERE staged.session_id = NEW.session_id
      AND staged.sandbox_id = NEW.sandbox_id
      AND staged.registration_generation != NEW.registration_generation
      AND NOT (
        staged.state = 'registering'
        AND staged.repair_generation = NEW.registration_generation
        AND staged.registration_claim = NEW.registration_claim
        AND staged.registration_claim_expires_at = NEW.registration_claim_expires_at
        AND NEW.state = 'registering'
      )
  )
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER fence_staged_credential_policy_update
BEFORE UPDATE ON interactive_session_credential_policies
WHEN NOT (OLD.state != 'cleanup_pending' AND NEW.state = 'cleanup_pending')
  AND EXISTS (
    SELECT 1
    FROM interactive_session_credential_policy_registrations AS staged
    WHERE staged.session_id = NEW.session_id
      AND staged.sandbox_id = NEW.sandbox_id
      AND staged.registration_generation != NEW.registration_generation
      AND NOT (
        staged.state = 'registering'
        AND staged.repair_generation = NEW.registration_generation
        AND staged.registration_claim = OLD.registration_claim
        AND staged.registration_claim_expires_at = OLD.registration_claim_expires_at
        AND OLD.state = 'registering'
        AND NEW.state = 'active'
        AND NEW.registration_claim IS NULL
        AND NEW.registration_claim_expires_at IS NULL
      )
  )
BEGIN
  SELECT RAISE(IGNORE);
END;
