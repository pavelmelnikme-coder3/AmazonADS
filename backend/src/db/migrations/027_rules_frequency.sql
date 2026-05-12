-- Add run_hour (UTC hour 0-23) and update schedule_type to support daily/every_3_days/weekly
ALTER TABLE rules ADD COLUMN IF NOT EXISTS run_hour INTEGER DEFAULT 8;
UPDATE rules SET schedule_type = 'daily' WHERE schedule_type NOT IN ('daily','every_3_days','weekly');
