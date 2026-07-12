DROP TRIGGER IF EXISTS protect_token_owned_desktop_host_update;
DROP TRIGGER IF EXISTS protect_token_owned_desktop_host_delete;

CREATE TRIGGER protect_token_owned_desktop_host_update
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
  SELECT RAISE(ABORT, 'token-owned desktop host update requires ownership token');
END;

CREATE TRIGGER protect_token_owned_desktop_host_delete
BEFORE DELETE ON desktop_hosts
WHEN OLD.ownership_token <> ''
  AND OLD.ownership_token NOT GLOB 'delete-authorized:*'
BEGIN
  SELECT RAISE(ABORT, 'token-owned desktop host delete requires ownership token');
END;
