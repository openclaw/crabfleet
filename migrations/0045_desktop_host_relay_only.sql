-- An empty address is never a direct connection target. Relay-only hosts use
-- the existing valid port storage range; clients must honor relay_only.
ALTER TABLE desktop_hosts
  ADD COLUMN relay_only INTEGER NOT NULL DEFAULT 0 CHECK (relay_only IN (0, 1));

-- Older publishers do not know this column. Their valid direct endpoint
-- clears a previous relay-only capability during a rolling upgrade.
CREATE TRIGGER clear_relay_only_for_direct_desktop
AFTER UPDATE ON desktop_hosts
WHEN NEW.address <> '' AND NEW.relay_only = 1
BEGIN
  UPDATE desktop_hosts SET relay_only = 0
  WHERE owner_subject = NEW.owner_subject AND id = NEW.id;
END;
