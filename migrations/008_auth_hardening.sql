-- Migration 008: Auth hardening — account enable/disable, login lockout, auth audit log.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active       BOOLEAN     NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_attempts INT         NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until    TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS auth_events (
  id         BIGSERIAL    PRIMARY KEY,
  email      VARCHAR(255),
  user_id    UUID,
  event      VARCHAR(30)  NOT NULL, -- login_success | login_failed | account_locked | login_blocked | user_created | user_disabled | user_enabled | password_changed
  ip         VARCHAR(64),
  user_agent VARCHAR(300),
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_events_email ON auth_events(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_events_time  ON auth_events(created_at DESC);
