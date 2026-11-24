-- Migration 007: Session Tracker — multi-session treatment packages,
-- per-session schedule, reminders (sms/email/call) and contact logs.

CREATE TABLE IF NOT EXISTS treatment_packages (
  id            SERIAL        PRIMARY KEY,
  package_code  VARCHAR(30)   UNIQUE NOT NULL,
  first_name    VARCHAR(120)  NOT NULL,
  last_name     VARCHAR(120)  NOT NULL DEFAULT '',
  phone         VARCHAR(40),
  phone_norm    VARCHAR(40),
  email         VARCHAR(200),
  branch        VARCHAR(80)   NOT NULL,
  treatment     VARCHAR(120)  NOT NULL,
  total_sessions INT          NOT NULL CHECK (total_sessions BETWEEN 1 AND 100),
  gap_days      INT           NOT NULL DEFAULT 14 CHECK (gap_days BETWEEN 1 AND 365),
  price_total   NUMERIC(12,2),
  status        VARCHAR(20)   NOT NULL DEFAULT 'Active',  -- Active | Completed | Paused | Cancelled | Expired
  start_date    DATE          NOT NULL,
  expiry_date   DATE,
  notes         TEXT,
  opt_out       BOOLEAN       NOT NULL DEFAULT FALSE,     -- no sms/email reminders for this customer
  source_booking_id VARCHAR(20) REFERENCES bookings(record_id),
  created_by    UUID,
  created_by_name VARCHAR(200),
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_packages_status     ON treatment_packages(status);
CREATE INDEX IF NOT EXISTS idx_packages_branch     ON treatment_packages(branch);
CREATE INDEX IF NOT EXISTS idx_packages_phone_norm ON treatment_packages(phone_norm);

CREATE TABLE IF NOT EXISTS package_sessions (
  id             SERIAL      PRIMARY KEY,
  package_id     INT         NOT NULL REFERENCES treatment_packages(id) ON DELETE CASCADE,
  session_no     INT         NOT NULL,
  scheduled_date DATE,
  scheduled_time VARCHAR(20),
  status         VARCHAR(20) NOT NULL DEFAULT 'Upcoming', -- Upcoming | Scheduled | Done | No Show | Cancelled
  done_at        TIMESTAMPTZ,
  booking_id     VARCHAR(20) REFERENCES bookings(record_id),
  notes          TEXT,
  UNIQUE (package_id, session_no)
);
CREATE INDEX IF NOT EXISTS idx_sessions_due
  ON package_sessions(scheduled_date)
  WHERE status IN ('Upcoming', 'Scheduled', 'No Show');

CREATE TABLE IF NOT EXISTS package_reminders (
  id            SERIAL      PRIMARY KEY,
  session_id    INT         NOT NULL REFERENCES package_sessions(id) ON DELETE CASCADE,
  channel       VARCHAR(10) NOT NULL,                     -- sms | email | call
  scheduled_for DATE        NOT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'Pending',   -- Pending | Sent | Failed | Cancelled | Done
  to_dest       VARCHAR(200),
  template_key  VARCHAR(40),
  sent_at       TIMESTAMPTZ,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, channel, scheduled_for)
);
CREATE INDEX IF NOT EXISTS idx_reminders_pending
  ON package_reminders(scheduled_for)
  WHERE status = 'Pending';

CREATE TABLE IF NOT EXISTS package_contact_logs (
  id            SERIAL      PRIMARY KEY,
  package_id    INT         NOT NULL REFERENCES treatment_packages(id) ON DELETE CASCADE,
  session_id    INT         REFERENCES package_sessions(id) ON DELETE SET NULL,
  channel       VARCHAR(10) NOT NULL DEFAULT 'call',      -- call | sms | email
  outcome       VARCHAR(30) NOT NULL,                     -- Answered | No answer | Confirmed | Rescheduled | Not interested | Other
  notes         TEXT,
  logged_by     UUID,
  logged_by_name VARCHAR(200),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contact_logs_package ON package_contact_logs(package_id, created_at DESC);
