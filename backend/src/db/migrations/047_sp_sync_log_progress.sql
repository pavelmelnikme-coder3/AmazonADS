-- Live progress for long-running SP-API sweeps.
--
-- The cross-country listing check is ~2 SP-API calls per (ASIN, country) — for
-- 551 ASINs across 9 marketplaces that is a couple of hours at the Catalog Items
-- pace. `records_fetched` / `records_upserted` are only written by _finishLog(),
-- so while a sweep runs there is nothing to report and the UI cannot tell a
-- running sweep from a finished one: the "check now" button re-enabled the
-- instant the job was *queued* and offered no sign of how far along it was.
--
-- These two columns are updated as the sweep walks its product list, so the
-- status endpoint can report real progress instead of guessing.
ALTER TABLE sp_sync_log ADD COLUMN IF NOT EXISTS progress_done  INTEGER;
ALTER TABLE sp_sync_log ADD COLUMN IF NOT EXISTS progress_total INTEGER;

-- The status endpoint looks up the newest running sweep of one type for one
-- workspace. The existing (workspace_id, sync_type, started_at DESC) index
-- already covers that lookup; this partial index keeps it cheap as the log grows,
-- since only a handful of rows are ever 'running'.
CREATE INDEX IF NOT EXISTS sp_sync_log_running_idx
  ON sp_sync_log (workspace_id, sync_type, started_at DESC)
  WHERE status = 'running';
