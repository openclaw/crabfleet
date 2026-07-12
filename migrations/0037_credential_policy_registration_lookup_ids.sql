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
