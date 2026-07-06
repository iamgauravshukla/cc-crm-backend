-- Migration 005: Meta Conversion identifier flag
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS is_meta_conversion BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_bookings_meta_conversion
  ON bookings(is_meta_conversion)
  WHERE is_meta_conversion = TRUE AND record_status != 'DELETED';
