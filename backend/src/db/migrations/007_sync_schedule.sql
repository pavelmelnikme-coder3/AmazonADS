ALTER TABLE amazon_connections
  ADD COLUMN IF NOT EXISTS sync_schedule TEXT NOT NULL DEFAULT 'daily'
    CHECK (sync_schedule IN ('hourly', 'daily', 'weekly'));

-- Update existing connections to daily (already the default)
UPDATE amazon_connections SET sync_schedule = 'daily' WHERE sync_schedule IS NULL;
