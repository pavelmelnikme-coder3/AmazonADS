-- 018: Store amazon_portfolio_id directly on campaigns for fast portfolio filtering.
-- The portfolios table holds names; campaigns store the raw Amazon ID.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS amazon_portfolio_id TEXT;

-- Populate from raw_data for all existing campaigns
UPDATE campaigns
  SET amazon_portfolio_id = raw_data->>'portfolioId'
  WHERE amazon_portfolio_id IS NULL
    AND raw_data->>'portfolioId' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_campaigns_amazon_portfolio_id
  ON campaigns (workspace_id, amazon_portfolio_id)
  WHERE amazon_portfolio_id IS NOT NULL;
