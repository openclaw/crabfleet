INSERT OR IGNORE INTO repos (repo, enabled, created_at, updated_at)
SELECT
  'openclaw/crabline',
  enabled,
  created_at,
  unixepoch() * 1000
FROM repos
WHERE repo = 'openclaw/multipass';

UPDATE cards
SET
  repo = 'openclaw/crabline',
  updated_at = unixepoch() * 1000
WHERE repo = 'openclaw/multipass';

INSERT OR IGNORE INTO repo_workflows (
  repo,
  status,
  source_path,
  source_sha,
  config_json,
  prompt,
  error,
  evaluated_at,
  updated_at
)
SELECT
  'openclaw/crabline',
  status,
  source_path,
  source_sha,
  config_json,
  prompt,
  error,
  evaluated_at,
  unixepoch() * 1000
FROM repo_workflows
WHERE repo = 'openclaw/multipass';

DELETE FROM repo_workflows WHERE repo = 'openclaw/multipass';
DELETE FROM repos WHERE repo = 'openclaw/multipass';
