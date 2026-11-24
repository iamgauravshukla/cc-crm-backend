-- Chat QA cost reuse: a run "contains" chats, some freshly scored, some reused
-- from earlier runs (no Pancake fetch, no GPT call). Reports read membership
-- from qa_run_items; qa_conversations stays one row per chat (latest scores).

CREATE TABLE IF NOT EXISTS qa_run_items (
  run_id  INT NOT NULL,
  conv_id INT NOT NULL,
  reused  BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (run_id, conv_id)
);
CREATE INDEX IF NOT EXISTS idx_qa_run_items_conv ON qa_run_items (conv_id);

ALTER TABLE qa_runs ADD COLUMN IF NOT EXISTS convs_reused INT NOT NULL DEFAULT 0;

-- Backfill: every existing scored chat belongs to the run that scored it
INSERT INTO qa_run_items (run_id, conv_id, reused)
SELECT run_id, id, false FROM qa_conversations WHERE run_id IS NOT NULL
ON CONFLICT (run_id, conv_id) DO NOTHING;
