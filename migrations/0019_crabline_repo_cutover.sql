INSERT OR IGNORE INTO repos (repo, enabled, created_at, updated_at)
SELECT
  'openclaw/crabline',
  enabled,
  created_at,
  unixepoch() * 1000
FROM repos
WHERE repo = 'openclaw/multipass';
