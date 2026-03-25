-- Search term performance from Amazon SP Search Term reports
CREATE TABLE IF NOT EXISTS search_term_metrics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id      UUID REFERENCES amazon_profiles(id) ON DELETE SET NULL,
  campaign_id     UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  ad_group_id     UUID REFERENCES ad_groups(id) ON DELETE SET NULL,
  campaign_name   TEXT,
  ad_group_name   TEXT,
  query           TEXT NOT NULL,
  keyword_id      UUID REFERENCES keywords(id) ON DELETE SET NULL,
  keyword_text    TEXT,
  match_type      TEXT,
  impressions     INTEGER DEFAULT 0,
  clicks          INTEGER DEFAULT 0,
  spend           NUMERIC(12,4) DEFAULT 0,
  orders          INTEGER DEFAULT 0,
  sales           NUMERIC(12,4) DEFAULT 0,
  date_start      DATE NOT NULL,
  date_end        DATE NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stm_workspace ON search_term_metrics(workspace_id);
CREATE INDEX IF NOT EXISTS idx_stm_query ON search_term_metrics(workspace_id, query);
CREATE INDEX IF NOT EXISTS idx_stm_campaign ON search_term_metrics(campaign_id);
CREATE INDEX IF NOT EXISTS idx_stm_dates ON search_term_metrics(date_start, date_end);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stm_unique
  ON search_term_metrics(workspace_id, campaign_id, query, date_start, date_end)
  WHERE campaign_id IS NOT NULL;
