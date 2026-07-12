ALTER TABLE interactive_session_credential_policy_registrations
  ADD COLUMN lookup_ids_json TEXT;

UPDATE interactive_session_credential_policy_registrations AS registration
SET lookup_ids_json = (
  SELECT json_group_array(lookup_id)
  FROM (
    SELECT DISTINCT lookup_id
    FROM (
      SELECT policy.lookup_id
      FROM interactive_session_credential_policies AS policy
      WHERE policy.session_id = registration.session_id
        AND policy.sandbox_id = registration.sandbox_id
      UNION ALL
      SELECT json_extract(rollback.value, '$.policy.sandboxId')
      FROM json_each(
        CASE
          WHEN json_valid(registration.rollback_policies_json)
            THEN registration.rollback_policies_json
          ELSE '[]'
        END
      ) AS rollback
      WHERE json_type(rollback.value, '$.policy.sandboxId') = 'text'
      UNION ALL
      SELECT registration.sandbox_id
    )
    WHERE typeof(lookup_id) = 'text' AND length(lookup_id) > 0
    ORDER BY lookup_id
  )
);

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
