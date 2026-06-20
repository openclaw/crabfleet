-- The stable-subject writer and one-time backfill shipped in the preceding
-- deployment. Every active writer now persists stable subjects directly.
UPDATE interactive_sessions
SET owner_subject = (
  SELECT CASE
    WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
    ELSE subject
  END
  FROM users
  WHERE allowed = 1
    AND (
      lower(owner) = lower(subject)
      OR (COALESCE(login, '') <> '' AND lower(owner) = lower(login))
      OR (COALESCE(login, '') <> '' AND lower(owner) = ('@' || lower(login)))
      OR (COALESCE(email, '') <> '' AND lower(owner) = lower(email))
    )
  LIMIT 1
)
WHERE owner_subject = ''
  AND (
    SELECT count(DISTINCT CASE
      WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
      ELSE subject
    END)
    FROM users
    WHERE allowed = 1
      AND (
        lower(owner) = lower(subject)
        OR (COALESCE(login, '') <> '' AND lower(owner) = lower(login))
        OR (COALESCE(login, '') <> '' AND lower(owner) = ('@' || lower(login)))
        OR (COALESCE(email, '') <> '' AND lower(owner) = lower(email))
      )
  ) = 1;

UPDATE interactive_sessions
SET control_requested_by_subject = (
  SELECT CASE
    WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
    ELSE subject
  END
  FROM users
  WHERE allowed = 1
    AND (
      lower(control_requested_by) = lower(subject)
      OR (COALESCE(login, '') <> '' AND lower(control_requested_by) = lower(login))
      OR (COALESCE(login, '') <> '' AND lower(control_requested_by) = ('@' || lower(login)))
      OR (COALESCE(email, '') <> '' AND lower(control_requested_by) = lower(email))
    )
  LIMIT 1
)
WHERE control_requested_by_subject IS NULL
  AND control_requested_by IS NOT NULL
  AND (
    SELECT count(DISTINCT CASE
      WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
      ELSE subject
    END)
    FROM users
    WHERE allowed = 1
      AND (
        lower(control_requested_by) = lower(subject)
        OR (COALESCE(login, '') <> '' AND lower(control_requested_by) = lower(login))
        OR (COALESCE(login, '') <> '' AND lower(control_requested_by) = ('@' || lower(login)))
        OR (COALESCE(email, '') <> '' AND lower(control_requested_by) = lower(email))
      )
  ) = 1;

UPDATE interactive_sessions
SET controller_subject = (
  SELECT CASE
    WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
    ELSE subject
  END
  FROM users
  WHERE allowed = 1
    AND (
      lower(controller) = lower(subject)
      OR (COALESCE(login, '') <> '' AND lower(controller) = lower(login))
      OR (COALESCE(login, '') <> '' AND lower(controller) = ('@' || lower(login)))
      OR (COALESCE(email, '') <> '' AND lower(controller) = lower(email))
    )
  LIMIT 1
)
WHERE controller_subject IS NULL
  AND controller IS NOT NULL
  AND (
    SELECT count(DISTINCT CASE
      WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
      ELSE subject
    END)
    FROM users
    WHERE allowed = 1
      AND (
        lower(controller) = lower(subject)
        OR (COALESCE(login, '') <> '' AND lower(controller) = lower(login))
        OR (COALESCE(login, '') <> '' AND lower(controller) = ('@' || lower(login)))
        OR (COALESCE(email, '') <> '' AND lower(controller) = lower(email))
      )
  ) = 1;

UPDATE cards
SET owner_subject = (
  SELECT CASE
    WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
    ELSE subject
  END
  FROM users
  WHERE allowed = 1
    AND (
      lower(owner) = lower(subject)
      OR (COALESCE(login, '') <> '' AND lower(owner) = lower(login))
      OR (COALESCE(login, '') <> '' AND lower(owner) = ('@' || lower(login)))
      OR (COALESCE(email, '') <> '' AND lower(owner) = lower(email))
    )
  LIMIT 1
)
WHERE owner_subject = ''
  AND (
    SELECT count(DISTINCT CASE
      WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
      ELSE subject
    END)
    FROM users
    WHERE allowed = 1
      AND (
        lower(owner) = lower(subject)
        OR (COALESCE(login, '') <> '' AND lower(owner) = lower(login))
        OR (COALESCE(login, '') <> '' AND lower(owner) = ('@' || lower(login)))
        OR (COALESCE(email, '') <> '' AND lower(owner) = lower(email))
      )
  ) = 1;

DROP TRIGGER IF EXISTS trg_tenant_session_owner_insert;
DROP TRIGGER IF EXISTS trg_tenant_card_owner_insert;
DROP TRIGGER IF EXISTS trg_tenant_control_request_insert;
DROP TRIGGER IF EXISTS trg_tenant_controller_insert;
DROP TRIGGER IF EXISTS trg_tenant_control_request_update;
DROP TRIGGER IF EXISTS trg_tenant_controller_update;
