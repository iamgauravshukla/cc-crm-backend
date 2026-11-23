-- Migration 010: Chat QA — named runs + per-agent learning store.

ALTER TABLE qa_runs ADD COLUMN IF NOT EXISTS name VARCHAR(140);

-- Accumulated knowledge about each agent, refreshed after every run.
-- Fed back into the GPT prompt as calibration context, and used by reports.
CREATE TABLE IF NOT EXISTS qa_agent_insights (
  agent_name      VARCHAR(200) PRIMARY KEY,   -- Pancake display name
  crm_agent       VARCHAR(200),               -- matched Master Bookings agent
  runs_count      INT          NOT NULL DEFAULT 0,
  convs_scored    INT          NOT NULL DEFAULT 0,
  avg_score       INT,
  criteria_avgs   JSONB,                      -- { greeting: 8.1, ... }
  strengths       TEXT[],                     -- top criteria labels
  weaknesses      TEXT[],                     -- bottom criteria labels
  top_flags       JSONB,                      -- [{ flag, count }]
  recent_tips     JSONB,                      -- last coaching tips
  booking_context JSONB,                      -- last booking stats used for calibration
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
