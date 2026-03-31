-- Store the raw Amazon campaign/ad-group IDs so we can resolve campaign names
-- even when the UUID lookup failed at ingestion time.
ALTER TABLE search_term_metrics
  ADD COLUMN IF NOT EXISTS amazon_campaign_id TEXT,
  ADD COLUMN IF NOT EXISTS amazon_ad_group_id TEXT;

CREATE INDEX IF NOT EXISTS idx_stm_amazon_campaign
  ON search_term_metrics (workspace_id, amazon_campaign_id)
  WHERE amazon_campaign_id IS NOT NULL;

-- Back-fill pass 1: rows that already have campaign_id UUID resolved
UPDATE search_term_metrics stm
SET amazon_campaign_id = c.amazon_campaign_id
FROM campaigns c
WHERE stm.campaign_id = c.id
  AND stm.amazon_campaign_id IS NULL;

-- Back-fill pass 2: rows with keyword_text → find campaign uniquely via keywords table
-- Only sets when a single campaign owns that keyword+match_type in this workspace
UPDATE search_term_metrics stm
SET amazon_campaign_id = sub.amazon_campaign_id,
    campaign_id        = sub.campaign_uuid
FROM (
  SELECT DISTINCT ON (stm2.id)
    stm2.id                 AS stm_id,
    c.amazon_campaign_id    AS amazon_campaign_id,
    c.id                    AS campaign_uuid
  FROM search_term_metrics stm2
  JOIN keywords k  ON k.workspace_id = stm2.workspace_id
                   AND LOWER(k.keyword_text) = LOWER(stm2.keyword_text)
                   AND k.match_type = stm2.match_type
  JOIN campaigns c ON c.id = k.campaign_id
  WHERE stm2.campaign_id IS NULL
    AND stm2.keyword_text IS NOT NULL
    AND stm2.amazon_campaign_id IS NULL
    -- Only proceed when the keyword maps to exactly one campaign
    AND (
      SELECT COUNT(DISTINCT k2.campaign_id)
      FROM keywords k2
      WHERE k2.workspace_id = stm2.workspace_id
        AND LOWER(k2.keyword_text) = LOWER(stm2.keyword_text)
        AND k2.match_type = stm2.match_type
    ) = 1
) sub
WHERE stm.id = sub.stm_id;
