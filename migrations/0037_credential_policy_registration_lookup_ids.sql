ALTER TABLE interactive_session_credential_policy_registrations
  ADD COLUMN lookup_ids_json TEXT;

-- Pre-migration staging rows may already have registered a new-generation
-- Durable Object lookup that D1 cannot reconstruct. Keep those rows nullable
-- so recovery derives the current compatibility lookup set at runtime.

DROP TRIGGER IF EXISTS fence_staged_credential_policy_delete;

CREATE TRIGGER fence_staged_credential_policy_delete
BEFORE DELETE ON interactive_session_credential_policies
WHEN EXISTS (
  SELECT 1
  FROM interactive_session_credential_policy_registrations AS staged
  WHERE staged.session_id = OLD.session_id
    AND staged.sandbox_id = OLD.sandbox_id
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
