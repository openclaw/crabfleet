ALTER TABLE desktop_hosts
  ADD COLUMN ownership_token TEXT NOT NULL DEFAULT '';

CREATE TRIGGER IF NOT EXISTS protect_token_owned_desktop_host_update
BEFORE UPDATE ON desktop_hosts
WHEN OLD.ownership_token <> ''
  AND NEW.ownership_token = OLD.ownership_token
  AND (
    NEW.owner_subject IS NOT OLD.owner_subject
    OR NEW.id IS NOT OLD.id
    OR NEW.owner IS NOT OLD.owner
    OR NEW.name IS NOT OLD.name
    OR NEW.address IS NOT OLD.address
    OR NEW.port IS NOT OLD.port
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.updated_at IS NOT OLD.updated_at
  )
BEGIN
  SELECT RAISE(IGNORE);
END;

-- Token-aware workers replace the exact token with this transient marker and
-- delete it in the same atomic batch. Legacy workers can never create it.
CREATE TRIGGER IF NOT EXISTS protect_token_owned_desktop_host_delete
BEFORE DELETE ON desktop_hosts
WHEN OLD.ownership_token <> ''
  AND OLD.ownership_token NOT GLOB 'delete-authorized:*'
BEGIN
  SELECT RAISE(IGNORE);
END;
