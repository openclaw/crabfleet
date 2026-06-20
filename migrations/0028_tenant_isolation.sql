-- Stable tenant ownership, named grants, and cutover compatibility triggers.
ALTER TABLE interactive_sessions ADD COLUMN owner_subject TEXT NOT NULL DEFAULT '';
ALTER TABLE interactive_sessions ADD COLUMN control_requested_by_subject TEXT;
ALTER TABLE interactive_sessions ADD COLUMN controller_subject TEXT;

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

CREATE INDEX IF NOT EXISTS idx_interactive_sessions_owner_subject
  ON interactive_sessions(owner_subject, updated_at DESC);

CREATE TABLE IF NOT EXISTS interactive_session_grants (
  session_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  principal TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'controller')),
  created_by_subject TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, subject),
  FOREIGN KEY (session_id) REFERENCES interactive_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_interactive_session_grants_subject
  ON interactive_session_grants(subject, expires_at, session_id);

ALTER TABLE cards ADD COLUMN owner_subject TEXT NOT NULL DEFAULT '';

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

CREATE INDEX IF NOT EXISTS idx_cards_owner_subject
  ON cards(owner_subject, updated_at DESC);

-- Bridge the migration/deploy window while an older Worker can still write rows
-- without stable subjects. A later, explicitly scheduled finalizer repeats the
-- backfill after old Worker requests have drained, then removes these triggers.
CREATE TRIGGER IF NOT EXISTS trg_tenant_session_owner_insert
AFTER INSERT ON interactive_sessions
WHEN NEW.owner_subject = ''
BEGIN
  UPDATE interactive_sessions
  SET owner_subject = (
    SELECT CASE
      WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
      ELSE subject
    END
    FROM users
    WHERE allowed = 1
      AND (
        lower(NEW.owner) = lower(subject)
        OR (COALESCE(login, '') <> '' AND lower(NEW.owner) = lower(login))
        OR (COALESCE(login, '') <> '' AND lower(NEW.owner) = ('@' || lower(login)))
        OR (COALESCE(email, '') <> '' AND lower(NEW.owner) = lower(email))
      )
    LIMIT 1
  )
  WHERE id = NEW.id
    AND (
      SELECT count(DISTINCT CASE
        WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
        ELSE subject
      END)
      FROM users
      WHERE allowed = 1
        AND (
          lower(NEW.owner) = lower(subject)
          OR (COALESCE(login, '') <> '' AND lower(NEW.owner) = lower(login))
          OR (COALESCE(login, '') <> '' AND lower(NEW.owner) = ('@' || lower(login)))
          OR (COALESCE(email, '') <> '' AND lower(NEW.owner) = lower(email))
        )
    ) = 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_tenant_card_owner_insert
AFTER INSERT ON cards
WHEN NEW.owner_subject = ''
BEGIN
  UPDATE cards
  SET owner_subject = (
    SELECT CASE
      WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
      ELSE subject
    END
    FROM users
    WHERE allowed = 1
      AND (
        lower(NEW.owner) = lower(subject)
        OR (COALESCE(login, '') <> '' AND lower(NEW.owner) = lower(login))
        OR (COALESCE(login, '') <> '' AND lower(NEW.owner) = ('@' || lower(login)))
        OR (COALESCE(email, '') <> '' AND lower(NEW.owner) = lower(email))
      )
    LIMIT 1
  )
  WHERE id = NEW.id
    AND (
      SELECT count(DISTINCT CASE
        WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
        ELSE subject
      END)
      FROM users
      WHERE allowed = 1
        AND (
          lower(NEW.owner) = lower(subject)
          OR (COALESCE(login, '') <> '' AND lower(NEW.owner) = lower(login))
          OR (COALESCE(login, '') <> '' AND lower(NEW.owner) = ('@' || lower(login)))
          OR (COALESCE(email, '') <> '' AND lower(NEW.owner) = lower(email))
        )
    ) = 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_tenant_control_request_insert
AFTER INSERT ON interactive_sessions
WHEN NEW.control_requested_by IS NOT NULL AND NEW.control_requested_by_subject IS NULL
BEGIN
  UPDATE interactive_sessions
  SET control_requested_by_subject = (
    SELECT CASE
      WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
      ELSE subject
    END
    FROM users
    WHERE allowed = 1
      AND (
        lower(NEW.control_requested_by) = lower(subject)
        OR (COALESCE(login, '') <> '' AND lower(NEW.control_requested_by) = lower(login))
        OR (COALESCE(login, '') <> '' AND lower(NEW.control_requested_by) = ('@' || lower(login)))
        OR (COALESCE(email, '') <> '' AND lower(NEW.control_requested_by) = lower(email))
      )
    LIMIT 1
  )
  WHERE id = NEW.id
    AND (
      SELECT count(DISTINCT CASE
        WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
        ELSE subject
      END)
      FROM users
      WHERE allowed = 1
        AND (
          lower(NEW.control_requested_by) = lower(subject)
          OR (COALESCE(login, '') <> '' AND lower(NEW.control_requested_by) = lower(login))
          OR (COALESCE(login, '') <> '' AND lower(NEW.control_requested_by) = ('@' || lower(login)))
          OR (COALESCE(email, '') <> '' AND lower(NEW.control_requested_by) = lower(email))
        )
    ) = 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_tenant_controller_insert
AFTER INSERT ON interactive_sessions
WHEN NEW.controller IS NOT NULL AND NEW.controller_subject IS NULL
BEGIN
  UPDATE interactive_sessions
  SET controller_subject = (
    SELECT CASE
      WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
      ELSE subject
    END
    FROM users
    WHERE allowed = 1
      AND (
        lower(NEW.controller) = lower(subject)
        OR (COALESCE(login, '') <> '' AND lower(NEW.controller) = lower(login))
        OR (COALESCE(login, '') <> '' AND lower(NEW.controller) = ('@' || lower(login)))
        OR (COALESCE(email, '') <> '' AND lower(NEW.controller) = lower(email))
      )
    LIMIT 1
  )
  WHERE id = NEW.id
    AND (
      SELECT count(DISTINCT CASE
        WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
        ELSE subject
      END)
      FROM users
      WHERE allowed = 1
        AND (
          lower(NEW.controller) = lower(subject)
          OR (COALESCE(login, '') <> '' AND lower(NEW.controller) = lower(login))
          OR (COALESCE(login, '') <> '' AND lower(NEW.controller) = ('@' || lower(login)))
          OR (COALESCE(email, '') <> '' AND lower(NEW.controller) = lower(email))
        )
    ) = 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_tenant_control_request_update
AFTER UPDATE OF control_requested_by ON interactive_sessions
WHEN NEW.control_requested_by IS NOT OLD.control_requested_by
  AND NEW.control_requested_by_subject IS OLD.control_requested_by_subject
BEGIN
  UPDATE interactive_sessions
  SET control_requested_by_subject = CASE
    WHEN NEW.control_requested_by IS NULL THEN NULL
    WHEN (
      SELECT count(DISTINCT CASE
        WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
        ELSE subject
      END)
      FROM users
      WHERE allowed = 1
        AND (
          lower(NEW.control_requested_by) = lower(subject)
          OR (COALESCE(login, '') <> '' AND lower(NEW.control_requested_by) = lower(login))
          OR (COALESCE(login, '') <> '' AND lower(NEW.control_requested_by) = ('@' || lower(login)))
          OR (COALESCE(email, '') <> '' AND lower(NEW.control_requested_by) = lower(email))
        )
    ) = 1 THEN (
      SELECT CASE
        WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
        ELSE subject
      END
      FROM users
      WHERE allowed = 1
        AND (
          lower(NEW.control_requested_by) = lower(subject)
          OR (COALESCE(login, '') <> '' AND lower(NEW.control_requested_by) = lower(login))
          OR (COALESCE(login, '') <> '' AND lower(NEW.control_requested_by) = ('@' || lower(login)))
          OR (COALESCE(email, '') <> '' AND lower(NEW.control_requested_by) = lower(email))
        )
      LIMIT 1
    )
    ELSE NULL
  END
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_tenant_controller_update
AFTER UPDATE OF controller ON interactive_sessions
WHEN NEW.controller IS NOT OLD.controller
  AND NEW.controller_subject IS OLD.controller_subject
BEGIN
  UPDATE interactive_sessions
  SET controller_subject = CASE
    WHEN NEW.controller IS NULL THEN NULL
    WHEN (
      SELECT count(DISTINCT CASE
        WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
        ELSE subject
      END)
      FROM users
      WHERE allowed = 1
        AND (
          lower(NEW.controller) = lower(subject)
          OR (COALESCE(login, '') <> '' AND lower(NEW.controller) = lower(login))
          OR (COALESCE(login, '') <> '' AND lower(NEW.controller) = ('@' || lower(login)))
          OR (COALESCE(email, '') <> '' AND lower(NEW.controller) = lower(email))
        )
    ) = 1 THEN (
      SELECT CASE
        WHEN lower(subject) LIKE 'bootstrap:%' THEN 'bootstrap:owner'
        ELSE subject
      END
      FROM users
      WHERE allowed = 1
        AND (
          lower(NEW.controller) = lower(subject)
          OR (COALESCE(login, '') <> '' AND lower(NEW.controller) = lower(login))
          OR (COALESCE(login, '') <> '' AND lower(NEW.controller) = ('@' || lower(login)))
          OR (COALESCE(email, '') <> '' AND lower(NEW.controller) = lower(email))
        )
      LIMIT 1
    )
    ELSE NULL
  END
  WHERE id = NEW.id;
END;
