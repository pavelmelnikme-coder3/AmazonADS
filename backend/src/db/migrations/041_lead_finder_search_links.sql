-- Fixes a correctness bug in Lead Finder: re-running an overlapping search (same city bbox,
-- another business-type query) used to reassign a business's search_id to the newest search,
-- silently emptying older searches' result views. A business now stays linked to every search
-- that surfaced it via this join table; lead_results.search_id is kept only as "first found by".
CREATE TABLE IF NOT EXISTS lead_search_results (
  search_id  UUID        NOT NULL REFERENCES lead_searches(id) ON DELETE CASCADE,
  result_id  UUID        NOT NULL REFERENCES lead_results(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (search_id, result_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_search_results_result ON lead_search_results(result_id);

-- Backfill: every existing lead_result was originally surfaced by its current search_id.
INSERT INTO lead_search_results (search_id, result_id)
SELECT search_id, id FROM lead_results
ON CONFLICT DO NOTHING;
