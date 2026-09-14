-- Existing native clients retain their read-only authorization contract.
ALTER TABLE native_device_authorizations
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'fleet:read';
