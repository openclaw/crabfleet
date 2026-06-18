ALTER TABLE cards ADD COLUMN schedule_json TEXT NOT NULL DEFAULT '';
ALTER TABLE cards ADD COLUMN next_run_at INTEGER;
ALTER TABLE cards ADD COLUMN last_scheduled_run_at INTEGER;
ALTER TABLE cards ADD COLUMN schedule_claimed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_cards_recurring_due
  ON cards(next_run_at)
  WHERE schedule_json != '' AND next_run_at IS NOT NULL;
