-- Migration 006: Scope saved filter views to a page
-- (Master Bookings, Daily Reports, CC Booking Report each keep their own views)

ALTER TABLE saved_views ADD COLUMN IF NOT EXISTS page VARCHAR(40) NOT NULL DEFAULT 'bookings';

ALTER TABLE saved_views DROP CONSTRAINT IF EXISTS uq_saved_views_user_name;
ALTER TABLE saved_views ADD CONSTRAINT uq_saved_views_user_page_name UNIQUE (user_id, page, name);

CREATE INDEX IF NOT EXISTS idx_saved_views_user_page ON saved_views(user_id, page);
