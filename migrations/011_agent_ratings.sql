-- Phase 1: Agent Intelligence
-- 1) customer phone on scored chats (enables chat → booking attribution)
-- 2) permanent Pancake-name ↔ CRM-agent mapping
-- 3) stored Agent Capability Index history
-- 4) small settings store (ACI weights)

ALTER TABLE qa_conversations ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(40);
CREATE INDEX IF NOT EXISTS idx_qa_conv_phone ON qa_conversations (customer_phone) WHERE customer_phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS qa_agent_map (
  id            SERIAL PRIMARY KEY,
  pancake_name  VARCHAR(200) UNIQUE NOT NULL,
  crm_agent     VARCHAR(200),          -- NULL = confirmed "no CRM counterpart"
  confirmed     BOOLEAN NOT NULL DEFAULT false,
  updated_by    VARCHAR(200),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_ratings (
  id           SERIAL PRIMARY KEY,
  agent_key    VARCHAR(200) NOT NULL,  -- canonical identity: CRM agent when mapped, else Pancake name
  period_from  DATE NOT NULL,
  period_to    DATE NOT NULL,
  components   JSONB NOT NULL,         -- { chatQa: {score, value, weight, available}, ... }
  aci          NUMERIC(5,1),
  tier         CHAR(1),
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_key, period_from, period_to)
);
CREATE INDEX IF NOT EXISTS idx_agent_ratings_period ON agent_ratings (period_from, period_to);

CREATE TABLE IF NOT EXISTS qa_settings (
  key        VARCHAR(60) PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
