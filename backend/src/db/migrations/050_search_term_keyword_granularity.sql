-- Search terms: store one row per report row, not one per (campaign, query, day).
--
-- Amazon's spSearchTerm/sbSearchTerm report is emitted at
-- (date, campaign, ad group, keyword, match type, search term) granularity: the same shopper
-- query comes back once per keyword that matched it. `idx_stm_unique` keyed only on
-- (workspace, campaign, query, dates), so every one of those rows collided on a single slot and
-- the ingest's `DO UPDATE SET clicks = EXCLUDED.clicks` OVERWROTE instead of adding — the last
-- row processed won and the rest were discarded.
--
-- Measured on the live 2026-09-06 SP report: Amazon returned 392 rows, 383 landed. 547 clicks
-- and EUR 322.46 of spend became 527 clicks and EUR 305.99. The search term "keilkissen bett"
-- really took 10 clicks that day and was stored as 1.
--
-- That is the input the negative-keyword rules threshold on ("8 clicks, 0 orders"), so terms
-- that had earned a negative never reached the threshold — and the surviving row kept the
-- ad_group_id of whichever row inserted first while carrying the metrics of whichever wrote
-- last, so reconciliation's per-ad-group slices scored the wrong ad group.
--
-- Widening the key to the report's own granularity fixes both: each keyword/match-type/ad-group
-- slice gets its own row, and everything downstream already SUMs over the range it wants
-- (routes/rules.js groups by (query, campaign, ad_group, match_type); routes/searchTerms.js
-- groups by (query, campaign, ad_group, keyword, match_type) — which is what its own comment
-- already claimed the table held).
--
-- Existing rows are unique under the old, narrower key, so they are unique under this wider one
-- too and the index builds without deduplication. Historical days stay collapsed until their
-- report is re-ingested; the daily pipeline re-requests a trailing 14-day window, so the last
-- two weeks heal on their own and longer rule windows need an explicit backfill.

CREATE UNIQUE INDEX IF NOT EXISTS idx_stm_unique_v2
  ON search_term_metrics (
    workspace_id,
    campaign_id,
    COALESCE(ad_group_id, '00000000-0000-0000-0000-000000000000'::uuid),
    query,
    COALESCE(keyword_text, ''),
    COALESCE(match_type, ''),
    date_start,
    date_end
  )
  WHERE campaign_id IS NOT NULL;

DROP INDEX IF EXISTS idx_stm_unique;
