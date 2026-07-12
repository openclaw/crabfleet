ALTER TABLE desktop_hosts
  ADD COLUMN publication_id TEXT NOT NULL DEFAULT '';

-- Older token-aware workers replace ownership_token without knowing about
-- publication_id. Clear the stale identity so a previous publisher cannot
-- recover authority over the replacement row.
CREATE TRIGGER IF NOT EXISTS clear_stale_desktop_host_publication_identity
AFTER UPDATE ON desktop_hosts
WHEN OLD.publication_id <> ''
  AND NEW.ownership_token <> OLD.ownership_token
  AND NEW.publication_id = OLD.publication_id
BEGIN
  UPDATE desktop_hosts
  SET publication_id = ''
  WHERE owner_subject = NEW.owner_subject
    AND id = NEW.id
    AND ownership_token = NEW.ownership_token
    AND publication_id = NEW.publication_id;
END;
