CREATE TABLE IF NOT EXISTS native_device_authorizations (
  device_code_hash TEXT PRIMARY KEY,
  link_code_hash TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  remote_ip TEXT,
  subject TEXT,
  access_token_hash TEXT,
  access_token_ciphertext TEXT,
  access_token_expires_at INTEGER,
  expires_at INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL,
  approved_at INTEGER,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (subject) REFERENCES users(subject)
);

CREATE INDEX IF NOT EXISTS idx_native_device_authorizations_remote_ip
  ON native_device_authorizations(remote_ip, created_at);

CREATE INDEX IF NOT EXISTS idx_native_device_authorizations_expires_at
  ON native_device_authorizations(expires_at);

CREATE TABLE IF NOT EXISTS native_access_tokens (
  token_hash TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  scope TEXT NOT NULL,
  client_name TEXT NOT NULL,
  github_token_ciphertext TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (subject) REFERENCES users(subject)
);

CREATE INDEX IF NOT EXISTS idx_native_access_tokens_subject
  ON native_access_tokens(subject, expires_at);

CREATE INDEX IF NOT EXISTS idx_native_access_tokens_expires_at
  ON native_access_tokens(expires_at);
