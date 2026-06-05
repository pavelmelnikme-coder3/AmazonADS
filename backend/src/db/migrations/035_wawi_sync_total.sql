-- Live progress for the Wawi sync: per-entity expected total (where the API exposes it)
-- alongside the existing rows_synced. last_status now also uses 'pending' / 'running'.
ALTER TABLE wawi_sync_state ADD COLUMN IF NOT EXISTS total INTEGER;
