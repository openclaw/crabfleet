ALTER TABLE interactive_session_credential_policy_registrations
  ADD COLUMN registration_write_started INTEGER NOT NULL DEFAULT 0
  CHECK (registration_write_started IN (0, 1));

-- Existing staged rows may already have written a replacement generation to
-- the Durable Object. Conservatively retain their legacy-writer fence until
-- current recovery either completes or removes the staged registration.
UPDATE interactive_session_credential_policy_registrations
SET registration_write_started = 1;

DROP TRIGGER IF EXISTS fence_staged_credential_policy_insert;
DROP TRIGGER IF EXISTS fence_staged_credential_policy_update;
DROP TRIGGER IF EXISTS fence_staged_credential_policy_delete;

CREATE TRIGGER fence_staged_credential_policy_insert
BEFORE INSERT ON interactive_session_credential_policies
WHEN EXISTS (
  SELECT 1
  FROM interactive_session_credential_policy_registrations AS staged
  WHERE staged.session_id = NEW.session_id
    AND staged.sandbox_id = NEW.sandbox_id
    AND staged.registration_generation != NEW.registration_generation
    AND (
      (
        staged.registration_write_started = 1
        AND NOT (
          staged.state = 'cleanup_pending'
          AND NEW.state = 'cleanup_pending'
        )
      )
      OR (
        NEW.state != 'cleanup_pending'
        AND (
          (
            staged.state = 'registering'
            AND staged.registration_claim_expires_at >
              CAST(strftime('%s', 'now') AS INTEGER) * 1000
          )
          OR (
            staged.state = 'cleanup_pending'
            AND (
              staged.cleanup_claim_expires_at >
                CAST(strftime('%s', 'now') AS INTEGER) * 1000
              OR staged.updated_at >
                CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 300000
            )
          )
        )
      )
    )
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
WHEN EXISTS (
  SELECT 1
  FROM interactive_session_credential_policy_registrations AS staged
  WHERE staged.session_id = NEW.session_id
    AND staged.sandbox_id = NEW.sandbox_id
    AND staged.registration_generation != NEW.registration_generation
    AND (
      (
        staged.registration_write_started = 1
        AND NOT (
          (
            staged.state = 'cleanup_pending'
            AND OLD.state != 'cleanup_pending'
            AND NEW.state = 'cleanup_pending'
          )
          OR (
            staged.state = 'registering'
            AND staged.repair_generation = OLD.registration_generation
            AND NEW.registration_generation = OLD.registration_generation
            AND staged.registration_claim = NEW.cleanup_claim
            AND staged.registration_claim_expires_at = NEW.cleanup_claim_expires_at
            AND OLD.state = 'active'
            AND NEW.state = 'cleanup_pending'
            AND json_valid(staged.lookup_ids_json)
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(staged.lookup_ids_json) AS current_lookup
              WHERE current_lookup.type = 'text'
                AND current_lookup.value = OLD.lookup_id
            )
          )
        )
      )
      OR (
        NOT (OLD.state != 'cleanup_pending' AND NEW.state = 'cleanup_pending')
        AND (
          (
            staged.state = 'registering'
            AND staged.registration_claim_expires_at >
              CAST(strftime('%s', 'now') AS INTEGER) * 1000
          )
          OR (
            staged.state = 'cleanup_pending'
            AND (
              staged.cleanup_claim_expires_at >
                CAST(strftime('%s', 'now') AS INTEGER) * 1000
              OR staged.updated_at >
                CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 300000
            )
          )
        )
      )
    )
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

CREATE TRIGGER fence_staged_credential_policy_delete
BEFORE DELETE ON interactive_session_credential_policies
WHEN EXISTS (
  SELECT 1
  FROM interactive_session_credential_policy_registrations AS staged
  WHERE staged.session_id = OLD.session_id
    AND staged.sandbox_id = OLD.sandbox_id
    AND (
      staged.registration_write_started = 1
      OR (
        staged.state = 'registering'
        AND staged.registration_claim_expires_at >
          CAST(strftime('%s', 'now') AS INTEGER) * 1000
      )
      OR (
        staged.state = 'cleanup_pending'
        AND (
          staged.cleanup_claim_expires_at >
            CAST(strftime('%s', 'now') AS INTEGER) * 1000
          OR staged.updated_at >
            CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 300000
        )
      )
    )
    AND NOT (
      staged.state = 'registering'
      AND staged.repair_generation = OLD.registration_generation
      AND staged.registration_claim = OLD.cleanup_claim
      AND staged.registration_claim_expires_at = OLD.cleanup_claim_expires_at
      AND OLD.state = 'cleanup_pending'
      AND json_valid(staged.lookup_ids_json)
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(staged.lookup_ids_json) AS current_lookup
        WHERE current_lookup.type = 'text'
          AND current_lookup.value = OLD.lookup_id
      )
    )
)
BEGIN
  SELECT RAISE(IGNORE);
END;
