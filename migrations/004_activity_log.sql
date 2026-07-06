-- Migration 004: Per-booking activity / edit history log

CREATE TABLE IF NOT EXISTS booking_activity_log (
  id          BIGSERIAL    PRIMARY KEY,
  booking_id  VARCHAR(20)  NOT NULL REFERENCES bookings(record_id),
  user_id     UUID,
  user_name   VARCHAR(200) NOT NULL DEFAULT 'System',
  action      VARCHAR(50)  NOT NULL, -- CREATED | UPDATED | STATUS_CHANGED | BULK_STATUS
  changes     JSONB        NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_booking
  ON booking_activity_log(booking_id, created_at DESC);
