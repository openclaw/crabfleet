ALTER TABLE desktop_hosts
  ADD COLUMN publication_id TEXT NOT NULL DEFAULT '';

ALTER TABLE desktop_hosts
  ADD COLUMN publication_write_token TEXT NOT NULL DEFAULT '';

-- New workers rotate publication_write_token with ownership_token. Older
-- token-aware workers leave it unchanged, which identifies a token-only write
-- that must invalidate recovery authority for the previous publisher.
CREATE TRIGGER IF NOT EXISTS clear_stale_desktop_host_publication_identity
AFTER UPDATE ON desktop_hosts
WHEN OLD.publication_id <> ''
  AND NEW.ownership_token <> OLD.ownership_token
  AND NEW.publication_id = OLD.publication_id
  AND NEW.publication_write_token = OLD.publication_write_token
BEGIN
  UPDATE desktop_hosts
  SET publication_id = '',
      publication_write_token = ''
  WHERE owner_subject = NEW.owner_subject
    AND id = NEW.id
    AND ownership_token = NEW.ownership_token
    AND publication_id = NEW.publication_id
    AND publication_write_token = NEW.publication_write_token;
END;
