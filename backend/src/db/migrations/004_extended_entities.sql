-- 004_extended_entities.sql
-- Extended entity tables: portfolios, product_ads, targets, negative_keywords, negative_targets, budget_rules
-- Apply manually: docker exec adsflow_postgres psql -U adsflow -d adsflow -f /docker-entrypoint-initdb.d/004_extended_entities.sql

-- ─── PORTFOLIOS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portfolios (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id          UUID NOT NULL REFERENCES amazon_profiles(id) ON DELETE CASCADE,
  amazon_portfolio_id TEXT NOT NULL,
  name                TEXT,
  state               TEXT,
  budget_amount       NUMERIC(12,2),
  budget_currency     TEXT,
  budget_start_date   DATE,
  budget_end_date     DATE,
  raw_data            JSONB,
  synced_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, amazon_portfolio_id)
);

CREATE INDEX IF NOT EXISTS idx_portfolios_workspace ON portfolios(workspace_id);
CREATE INDEX IF NOT EXISTS idx_portfolios_profile   ON portfolios(profile_id);

-- Add portfolio_id FK to campaigns (nullable — not all campaigns belong to a portfolio)
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS portfolio_id UUID REFERENCES portfolios(id) ON DELETE SET NULL;

-- ─── PRODUCT ADS ──────────────────────────────────────────────────────────────
-- Individual Sponsored Products ads (ASIN/SKU level)
CREATE TABLE IF NOT EXISTS product_ads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id      UUID NOT NULL REFERENCES amazon_profiles(id) ON DELETE CASCADE,
  campaign_id     UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  ad_group_id     UUID REFERENCES ad_groups(id) ON DELETE CASCADE,
  amazon_ad_id    TEXT NOT NULL,
  asin            TEXT,
  sku             TEXT,
  state           TEXT,
  raw_data        JSONB,
  synced_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, amazon_ad_id)
);

CREATE INDEX IF NOT EXISTS idx_product_ads_workspace  ON product_ads(workspace_id);
CREATE INDEX IF NOT EXISTS idx_product_ads_profile    ON product_ads(profile_id);
CREATE INDEX IF NOT EXISTS idx_product_ads_campaign   ON product_ads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_product_ads_ad_group   ON product_ads(ad_group_id);

-- ─── TARGETS ──────────────────────────────────────────────────────────────────
-- SP product/category targeting + SD targets
CREATE TABLE IF NOT EXISTS targets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id          UUID NOT NULL REFERENCES amazon_profiles(id) ON DELETE CASCADE,
  campaign_id         UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  ad_group_id         UUID REFERENCES ad_groups(id) ON DELETE CASCADE,
  amazon_target_id    TEXT NOT NULL,
  ad_type             TEXT NOT NULL DEFAULT 'SP', -- SP | SD
  expression_type     TEXT,        -- manual | auto
  expression          JSONB,       -- [{type: "asinSameAs", value: "B123"}]
  resolved_expression JSONB,
  state               TEXT,
  bid                 NUMERIC(8,4),
  raw_data            JSONB,
  synced_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, amazon_target_id)
);

CREATE INDEX IF NOT EXISTS idx_targets_workspace  ON targets(workspace_id);
CREATE INDEX IF NOT EXISTS idx_targets_profile    ON targets(profile_id);
CREATE INDEX IF NOT EXISTS idx_targets_campaign   ON targets(campaign_id);
CREATE INDEX IF NOT EXISTS idx_targets_ad_group   ON targets(ad_group_id);

-- ─── NEGATIVE KEYWORDS ────────────────────────────────────────────────────────
-- Both campaign-level (campaignNegativeKeywords) and ad-group-level (negativeKeywords)
CREATE TABLE IF NOT EXISTS negative_keywords (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id            UUID NOT NULL REFERENCES amazon_profiles(id) ON DELETE CASCADE,
  campaign_id           UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  ad_group_id           UUID REFERENCES ad_groups(id) ON DELETE SET NULL,  -- NULL for campaign-level
  amazon_neg_keyword_id TEXT NOT NULL,
  keyword_text          TEXT,
  match_type            TEXT,
  level                 TEXT NOT NULL DEFAULT 'ad_group', -- 'campaign' | 'ad_group'
  raw_data              JSONB,
  synced_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, amazon_neg_keyword_id)
);

CREATE INDEX IF NOT EXISTS idx_neg_kw_workspace  ON negative_keywords(workspace_id);
CREATE INDEX IF NOT EXISTS idx_neg_kw_profile    ON negative_keywords(profile_id);
CREATE INDEX IF NOT EXISTS idx_neg_kw_campaign   ON negative_keywords(campaign_id);

-- ─── NEGATIVE TARGETS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS negative_targets (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id           UUID NOT NULL REFERENCES amazon_profiles(id) ON DELETE CASCADE,
  campaign_id          UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  ad_group_id          UUID REFERENCES ad_groups(id) ON DELETE SET NULL,
  amazon_neg_target_id TEXT NOT NULL,
  ad_type              TEXT NOT NULL DEFAULT 'SP', -- SP | SD
  expression           JSONB,
  expression_type      TEXT,
  level                TEXT NOT NULL DEFAULT 'ad_group',
  raw_data             JSONB,
  synced_at            TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, amazon_neg_target_id)
);

CREATE INDEX IF NOT EXISTS idx_neg_targets_workspace  ON negative_targets(workspace_id);
CREATE INDEX IF NOT EXISTS idx_neg_targets_profile    ON negative_targets(profile_id);
CREATE INDEX IF NOT EXISTS idx_neg_targets_campaign   ON negative_targets(campaign_id);

-- ─── BUDGET RULES ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS budget_rules (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id              UUID NOT NULL REFERENCES amazon_profiles(id) ON DELETE CASCADE,
  campaign_id             UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  amazon_rule_id          TEXT NOT NULL,
  rule_type               TEXT,
  name                    TEXT,
  status                  TEXT,
  budget_increase_by      NUMERIC,
  budget_increase_by_type TEXT,
  start_date              DATE,
  end_date                DATE,
  raw_data                JSONB,
  synced_at               TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, amazon_rule_id)
);

CREATE INDEX IF NOT EXISTS idx_budget_rules_workspace ON budget_rules(workspace_id);
CREATE INDEX IF NOT EXISTS idx_budget_rules_campaign  ON budget_rules(campaign_id);

-- ─── Triggers for updated_at ──────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'portfolios_updated_at') THEN
    CREATE TRIGGER portfolios_updated_at BEFORE UPDATE ON portfolios FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'product_ads_updated_at') THEN
    CREATE TRIGGER product_ads_updated_at BEFORE UPDATE ON product_ads FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'targets_updated_at') THEN
    CREATE TRIGGER targets_updated_at BEFORE UPDATE ON targets FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'negative_keywords_updated_at') THEN
    CREATE TRIGGER negative_keywords_updated_at BEFORE UPDATE ON negative_keywords FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'negative_targets_updated_at') THEN
    CREATE TRIGGER negative_targets_updated_at BEFORE UPDATE ON negative_targets FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'budget_rules_updated_at') THEN
    CREATE TRIGGER budget_rules_updated_at BEFORE UPDATE ON budget_rules FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;
