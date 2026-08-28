-- Migration 003: CRM features (follow-up dates, saved views)

-- Follow-up date on bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS follow_up_date DATE;
CREATE INDEX IF NOT EXISTS idx_bookings_follow_up
  ON bookings(follow_up_date)
  WHERE follow_up_date IS NOT NULL AND record_status != 'DELETED';

-- Saved filter views per user
CREATE TABLE IF NOT EXISTS saved_views (
  id         SERIAL       PRIMARY KEY,
  user_id    UUID         NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  name       VARCHAR(100) NOT NULL,
  filters    JSONB        NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_saved_views_user_name UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_saved_views_user ON saved_views(user_id);
