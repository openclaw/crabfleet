ALTER TABLE cards ADD COLUMN schedule_json TEXT NOT NULL DEFAULT '';
ALTER TABLE cards ADD COLUMN next_run_at INTEGER;
ALTER TABLE cards ADD COLUMN last_scheduled_run_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_cards_next_run_at ON cards(next_run_at);
