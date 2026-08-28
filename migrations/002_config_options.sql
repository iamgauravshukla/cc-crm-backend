-- Config options for dropdown values in booking forms
-- Idempotent: safe to run multiple times

CREATE TABLE IF NOT EXISTS config_options (
  id          SERIAL      PRIMARY KEY,
  category    VARCHAR(50) NOT NULL,
  value       TEXT        NOT NULL,
  sort_order  INT         NOT NULL DEFAULT 0,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_config_category_value UNIQUE (category, value)
);

CREATE INDEX IF NOT EXISTS idx_config_category_active
  ON config_options(category) WHERE is_active = TRUE;
