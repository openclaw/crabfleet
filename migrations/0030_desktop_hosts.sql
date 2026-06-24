CREATE TABLE IF NOT EXISTS desktop_hosts (
  owner_subject TEXT NOT NULL,
  id TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port >= 1 AND port <= 65535),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_subject, id)
);

CREATE INDEX IF NOT EXISTS idx_desktop_hosts_owner_updated
  ON desktop_hosts(owner_subject, updated_at DESC);
