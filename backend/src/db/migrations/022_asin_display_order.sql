-- 022_asin_display_order.sql
-- User-configurable ordering of ASIN groups in Rank Tracker

ALTER TABLE asin_labels ADD COLUMN IF NOT EXISTS display_order INTEGER DEFAULT NULL;
