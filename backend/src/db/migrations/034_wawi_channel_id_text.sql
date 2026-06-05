-- Wawi sales-channel ids are composite STRINGS (e.g. "1-1-0", "9-7-2--1"), not integers.
-- Fix the column types (tables are freshly created in 033, so this is a clean retype).
ALTER TABLE wawi_sales_channels ALTER COLUMN wawi_id TYPE TEXT USING wawi_id::text;
ALTER TABLE wawi_sales_orders   ALTER COLUMN sales_channel_id TYPE TEXT USING sales_channel_id::text;
