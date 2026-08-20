UPDATE repos
SET
  enabled = 0,
  updated_at = unixepoch() * 1000
WHERE
  repo IN ('openclaw/clawsweeper-home', 'openclaw/crabbox-fleet')
  AND enabled <> 0;
