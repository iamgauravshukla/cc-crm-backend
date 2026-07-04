-- ============================================================
-- BookingTrack — PostgreSQL schema
-- Run once via: npm run db:setup
-- All statements are idempotent (IF NOT EXISTS / IF EXISTS)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  user_id       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(200) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(100) NOT NULL,
  role          VARCHAR(20)  NOT NULL DEFAULT 'agent',  -- agent | Admin
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_login    TIMESTAMPTZ
);

-- ── bookings ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookings (
  -- identity & meta
  id             SERIAL       PRIMARY KEY,
  record_id      VARCHAR(60)  UNIQUE NOT NULL,
  record_status  VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  created_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- core booking
  branch         VARCHAR(100) NOT NULL DEFAULT '',
  booking_status VARCHAR(60)  NOT NULL DEFAULT 'Scheduled',
  booking_date   DATE,
  booking_time   VARCHAR(20),
  appointment_date DATE,
  appointment_time VARCHAR(20),
  cancellation_time TIMESTAMPTZ,

  -- customer
  first_name     VARCHAR(100) NOT NULL DEFAULT '',
  last_name      VARCHAR(100) NOT NULL DEFAULT '',
  age            INTEGER,
  gender         VARCHAR(20),
  phone          VARCHAR(30),
  email          VARCHAR(200),
  social_media   VARCHAR(200),

  -- treatment & pricing
  treatment      VARCHAR(200),
  area           VARCHAR(100),
  freebie        VARCHAR(200),
  total_price    DECIMAL(10,2) NOT NULL DEFAULT 0,
  payment_mode   VARCHAR(50),

  -- companion
  companion_treatment   VARCHAR(200),
  companion_first_name  VARCHAR(100),
  companion_last_name   VARCHAR(100),
  companion_age         INTEGER,
  companion_gender      VARCHAR(20),
  companion_freebie     VARCHAR(200),
  companion_area        VARCHAR(100),

  -- agent & notes
  agent           VARCHAR(100),
  booking_details TEXT,
  remarks         TEXT,          -- agent fills during booking creation
  purchase_details TEXT,         -- agent/admin fills post-visit

  -- marketing
  ad_interacted  VARCHAR(200),

  -- normalized search fields (auto-computed, indexed)
  email_norm              VARCHAR(200),
  phone_norm              VARCHAR(20),
  social_norm             VARCHAR(200),
  full_name_norm          VARCHAR(200),
  companion_full_name_norm VARCHAR(200),

  -- promo hunter / dedup
  promo_hunter_status VARCHAR(50),
  match_reason        TEXT,
  matched_source      VARCHAR(50),
  matched_row         VARCHAR(60),
  last_checked_at     TIMESTAMPTZ,

  -- validation flags
  cancel_validation    BOOLEAN NOT NULL DEFAULT FALSE,
  underage_status      VARCHAR(50),
  underage_cancellation BOOLEAN NOT NULL DEFAULT FALSE,
  db_status            VARCHAR(50),

  -- dashboard & audit
  legacy_full_name        VARCHAR(200),
  exclude_from_dashboards BOOLEAN NOT NULL DEFAULT FALSE,

  -- identifier checkboxes (new — FALSE for all historical records)
  is_ots          BOOLEAN NOT NULL DEFAULT FALSE,
  is_ad_id        BOOLEAN NOT NULL DEFAULT FALSE,
  is_companion    BOOLEAN NOT NULL DEFAULT FALSE,
  is_high_priority BOOLEAN NOT NULL DEFAULT FALSE
);

-- ── bookings indexes ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_b_branch         ON bookings (branch);
CREATE INDEX IF NOT EXISTS idx_b_status         ON bookings (booking_status);
CREATE INDEX IF NOT EXISTS idx_b_appt_date      ON bookings (appointment_date);
CREATE INDEX IF NOT EXISTS idx_b_booking_date   ON bookings (booking_date);
CREATE INDEX IF NOT EXISTS idx_b_created_at     ON bookings (created_at);
CREATE INDEX IF NOT EXISTS idx_b_agent          ON bookings (agent);
CREATE INDEX IF NOT EXISTS idx_b_email_norm     ON bookings (email_norm);
CREATE INDEX IF NOT EXISTS idx_b_phone_norm     ON bookings (phone_norm);
CREATE INDEX IF NOT EXISTS idx_b_full_name_norm ON bookings (full_name_norm);
CREATE INDEX IF NOT EXISTS idx_b_promo_status   ON bookings (promo_hunter_status);
CREATE INDEX IF NOT EXISTS idx_b_exclude        ON bookings (exclude_from_dashboards);

-- composite indexes for the most common report patterns
CREATE INDEX IF NOT EXISTS idx_b_branch_appt    ON bookings (branch, appointment_date);
CREATE INDEX IF NOT EXISTS idx_b_branch_status  ON bookings (branch, booking_status);
CREATE INDEX IF NOT EXISTS idx_b_created_branch ON bookings (created_at, branch);

-- partial indexes for identifier checkboxes (low cardinality — partial is faster)
CREATE INDEX IF NOT EXISTS idx_b_ots            ON bookings (appointment_date) WHERE is_ots = TRUE;
CREATE INDEX IF NOT EXISTS idx_b_companion      ON bookings (branch)           WHERE is_companion = TRUE;
CREATE INDEX IF NOT EXISTS idx_b_ad_id          ON bookings (branch)           WHERE is_ad_id = TRUE;
CREATE INDEX IF NOT EXISTS idx_b_high_priority  ON bookings (branch)           WHERE is_high_priority = TRUE;

-- ── call_leads ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS call_leads (
  id         SERIAL       PRIMARY KEY,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  center     VARCHAR(100) NOT NULL,
  full_name  VARCHAR(200) NOT NULL,
  email      VARCHAR(200) NOT NULL,
  phone      VARCHAR(30)  NOT NULL,
  treatment  VARCHAR(200) NOT NULL,
  message    TEXT,
  status     VARCHAR(30)  NOT NULL DEFAULT 'New',
  feedback   TEXT
);

CREATE INDEX IF NOT EXISTS idx_cl_center     ON call_leads (center);
CREATE INDEX IF NOT EXISTS idx_cl_created_at ON call_leads (created_at);
CREATE INDEX IF NOT EXISTS idx_cl_status     ON call_leads (status);

-- ── booking_leads ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_leads (
  id             SERIAL       PRIMARY KEY,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  center         VARCHAR(100) NOT NULL,
  full_name      VARCHAR(200) NOT NULL,
  email          VARCHAR(200) NOT NULL,
  phone          VARCHAR(30)  NOT NULL,
  treatment      VARCHAR(200) NOT NULL,
  age            VARCHAR(10),
  schedule       VARCHAR(200) NOT NULL,
  payment_method VARCHAR(50),
  status         VARCHAR(30)  NOT NULL DEFAULT 'New',
  feedback       TEXT
);

CREATE INDEX IF NOT EXISTS idx_bl_center     ON booking_leads (center);
CREATE INDEX IF NOT EXISTS idx_bl_created_at ON booking_leads (created_at);
CREATE INDEX IF NOT EXISTS idx_bl_status     ON booking_leads (status);

-- ── updated_at auto-trigger ──────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bookings_updated_at ON bookings;
CREATE TRIGGER trg_bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
