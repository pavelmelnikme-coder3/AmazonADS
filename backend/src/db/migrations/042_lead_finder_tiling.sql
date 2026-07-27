-- Country-scale Lead Finder search: a whole-country bbox is too large for one Overpass query
-- (regex tag-scans over ~80 sq-degrees blow past Overpass's own 25s budget). Large regions now
-- get split into a grid of tiles and processed by a background job (see workers.js
-- "lead-finder-search" queue); these columns track that job's progress. Existing rows (all
-- synchronous, single-shot searches) default to an already-complete single "tile".
ALTER TABLE lead_searches
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed', -- running|completed|failed|cancelled
  ADD COLUMN IF NOT EXISTS tiles_total INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS tiles_done INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS truncated BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS job_id TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT;
