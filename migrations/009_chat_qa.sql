-- Migration 009: Chat QA — GPT-scored quality analysis of Pancake conversations.

CREATE TABLE IF NOT EXISTS qa_runs (
  id              SERIAL       PRIMARY KEY,
  page_id         VARCHAR(40)  NOT NULL,
  page_name       VARCHAR(120),
  run_type        VARCHAR(10)  NOT NULL DEFAULT 'manual',   -- manual | nightly
  since           TIMESTAMPTZ,
  until           TIMESTAMPTZ,
  agent_filter    VARCHAR(200),
  sample_size     INT,
  status          VARCHAR(12)  NOT NULL DEFAULT 'Running',  -- Running | Done | Failed
  convs_found     INT          NOT NULL DEFAULT 0,
  convs_analyzed  INT          NOT NULL DEFAULT 0,
  convs_skipped   INT          NOT NULL DEFAULT 0,
  convs_failed    INT          NOT NULL DEFAULT 0,
  tokens_in       BIGINT       NOT NULL DEFAULT 0,
  tokens_out      BIGINT       NOT NULL DEFAULT 0,
  model           VARCHAR(60),
  error           TEXT,
  created_by_name VARCHAR(200),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS qa_conversations (
  id                 SERIAL       PRIMARY KEY,
  run_id             INT          REFERENCES qa_runs(id) ON DELETE SET NULL,
  page_id            VARCHAR(40)  NOT NULL,
  page_name          VARCHAR(120),
  conversation_id    VARCHAR(120) NOT NULL,
  customer_name      VARCHAR(200),
  agent_name         VARCHAR(200),          -- primary (most messages) agent
  agent_names        TEXT[],                -- every staff member who replied
  msg_count          INT,
  agent_msg_count    INT,
  customer_msg_count INT,
  first_response_sec INT,
  max_gap_sec        INT,
  started_at         TIMESTAMPTZ,
  last_msg_at        TIMESTAMPTZ,
  transcript         JSONB,                 -- [{role, name, text, at, automated}]
  overall            INT,                   -- 0-100 weighted
  scores             JSONB,                 -- per-criterion {score, reason}
  red_flags          JSONB,                 -- ["..."]
  sentiment_start    VARCHAR(20),
  sentiment_end      VARCHAR(20),
  followthrough      BOOLEAN,
  summary            TEXT,
  coaching_tip       TEXT,
  model              VARCHAR(60),
  analyzed_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (page_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_qa_convs_agent ON qa_conversations(agent_name, last_msg_at DESC);
CREATE INDEX IF NOT EXISTS idx_qa_convs_time  ON qa_conversations(last_msg_at DESC);
CREATE INDEX IF NOT EXISTS idx_qa_convs_score ON qa_conversations(overall);
