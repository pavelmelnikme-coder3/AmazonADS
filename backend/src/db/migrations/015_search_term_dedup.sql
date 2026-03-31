-- Fix duplicate search_term_metrics rows for NULL campaign_id
-- (caused by missing deduplication when campaign could not be resolved)

-- Step 1: Remove duplicates — keep the row with most impressions per group
DELETE FROM search_term_metrics
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY workspace_id, query, COALESCE(keyword_text,''), COALESCE(match_type,''), date_start, date_end
             ORDER BY impressions DESC, created_at DESC
           ) AS rn
    FROM search_term_metrics
    WHERE campaign_id IS NULL
  ) ranked
  WHERE rn > 1
);

-- Step 2: Add partial unique index to prevent future duplicates for NULL campaign_id rows
CREATE UNIQUE INDEX IF NOT EXISTS idx_stm_null_campaign_unique
  ON search_term_metrics (workspace_id, query, COALESCE(keyword_text,''), COALESCE(match_type,''), date_start, date_end)
  WHERE campaign_id IS NULL;
