-- AdsFlow — Initial Schema Migration
-- Run: psql $DATABASE_URL -f 001_initial.sql

-- ─── Extensions ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for fast ILIKE searches

-- ─── Organizations & Users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  slug          TEXT UNIQUE NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'trial', -- trial, starter, pro, enterprise
  settings      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'analyst', -- owner, admin, analyst, media_buyer, ai_operator, read_only
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ─── Workspaces ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspaces (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  settings    JSONB NOT NULL DEFAULT '{}',
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'analyst',
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspaces_org ON workspaces(org_id);

-- ─── Amazon Connections ────────────────────────────────────────────────────────
-- Stores LwA OAuth tokens (encrypted at application level)
CREATE TABLE IF NOT EXISTS amazon_connections (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id        UUID REFERENCES workspaces(id),
  amazon_account_id   TEXT,                            -- Amazon seller/advertiser account ID
  amazon_email        TEXT,                            -- Amazon account email (from profile)
  access_token_enc    TEXT NOT NULL,                   -- AES-256-GCM encrypted
  refresh_token_enc   TEXT NOT NULL,                   -- AES-256-GCM encrypted
  token_expires_at    TIMESTAMPTZ NOT NULL,
  scopes              TEXT[] NOT NULL DEFAULT ARRAY['advertising::campaign_management'],
  status              TEXT NOT NULL DEFAULT 'active',  -- active, expired, revoked, error
  last_refresh_at     TIMESTAMPTZ,
  last_error          TEXT,
  error_count         INTEGER NOT NULL DEFAULT 0,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connections_org ON amazon_connections(org_id);
CREATE INDEX IF NOT EXISTS idx_connections_status ON amazon_connections(status);

-- ─── Amazon Profiles ──────────────────────────────────────────────────────────
-- Each profile = advertiser in a specific marketplace
CREATE TABLE IF NOT EXISTS amazon_profiles (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  connection_id   UUID NOT NULL REFERENCES amazon_connections(id) ON DELETE CASCADE,
  workspace_id    UUID REFERENCES workspaces(id),
  profile_id      BIGINT NOT NULL,                     -- Amazon's profileId (integer)
  marketplace_id  TEXT NOT NULL,                       -- e.g., ATVPDKIKX0DER
  marketplace     TEXT NOT NULL,                       -- e.g., US, UK, DE
  country_code    TEXT NOT NULL,                       -- e.g., US
  currency_code   TEXT NOT NULL,                       -- e.g., USD
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  account_name    TEXT,
  account_type    TEXT,                                -- seller, vendor, agency
  is_attached     BOOLEAN NOT NULL DEFAULT FALSE,      -- user chose to sync this profile
  last_synced_at  TIMESTAMPTZ,
  sync_status     TEXT DEFAULT 'pending',              -- pending, syncing, synced, error
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (connection_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_profiles_connection ON amazon_profiles(connection_id);
CREATE INDEX IF NOT EXISTS idx_profiles_workspace ON amazon_profiles(workspace_id);
CREATE INDEX IF NOT EXISTS idx_profiles_marketplace ON amazon_profiles(marketplace);

-- ─── Campaigns ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id          UUID NOT NULL REFERENCES amazon_profiles(id) ON DELETE CASCADE,
  amazon_campaign_id  TEXT NOT NULL,
  name                TEXT NOT NULL,
  campaign_type       TEXT NOT NULL,                   -- sponsoredProducts, sponsoredBrands, sponsoredDisplay
  targeting_type      TEXT,                            -- manual, auto
  state               TEXT NOT NULL DEFAULT 'enabled', -- enabled, paused, archived
  daily_budget        NUMERIC(12,2),
  start_date          DATE,
  end_date            DATE,
  bidding_strategy    TEXT,                            -- legacyForSales, autoForSales, manual
  premium_bid_adj     BOOLEAN DEFAULT FALSE,
  raw_data            JSONB,                           -- full response from Amazon API
  synced_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, amazon_campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_campaigns_workspace ON campaigns(workspace_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_profile ON campaigns(profile_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_state ON campaigns(state);
CREATE INDEX IF NOT EXISTS idx_campaigns_type ON campaigns(campaign_type);
CREATE INDEX IF NOT EXISTS idx_campaigns_name_trgm ON campaigns USING gin(name gin_trgm_ops);

-- ─── Ad Groups ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_groups (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id        UUID NOT NULL REFERENCES amazon_profiles(id) ON DELETE CASCADE,
  campaign_id       UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  amazon_ag_id      TEXT NOT NULL,
  name              TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'enabled',
  default_bid       NUMERIC(8,4),
  raw_data          JSONB,
  synced_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, amazon_ag_id)
);

CREATE INDEX IF NOT EXISTS idx_adgroups_campaign ON ad_groups(campaign_id);
CREATE INDEX IF NOT EXISTS idx_adgroups_workspace ON ad_groups(workspace_id);

-- ─── Keywords ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS keywords (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id          UUID NOT NULL REFERENCES amazon_profiles(id) ON DELETE CASCADE,
  ad_group_id         UUID NOT NULL REFERENCES ad_groups(id) ON DELETE CASCADE,
  campaign_id         UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  amazon_keyword_id   TEXT NOT NULL,
  keyword_text        TEXT NOT NULL,
  match_type          TEXT NOT NULL,                   -- exact, phrase, broad
  state               TEXT NOT NULL DEFAULT 'enabled',
  bid                 NUMERIC(8,4),
  raw_data            JSONB,
  synced_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, amazon_keyword_id)
);

CREATE INDEX IF NOT EXISTS idx_keywords_adgroup ON keywords(ad_group_id);
CREATE INDEX IF NOT EXISTS idx_keywords_campaign ON keywords(campaign_id);
CREATE INDEX IF NOT EXISTS idx_keywords_workspace ON keywords(workspace_id);
CREATE INDEX IF NOT EXISTS idx_keywords_text_trgm ON keywords USING gin(keyword_text gin_trgm_ops);

-- ─── Daily Metrics (Fact Table) ───────────────────────────────────────────────
-- Partitioned by date for performance
CREATE TABLE IF NOT EXISTS fact_metrics_daily (
  id            UUID NOT NULL DEFAULT uuid_generate_v4(),
  workspace_id  UUID NOT NULL,
  profile_id    UUID NOT NULL,
  date          DATE NOT NULL,
  entity_type   TEXT NOT NULL,     -- campaign, ad_group, keyword, target
  entity_id     UUID,              -- references the entity table
  amazon_id     TEXT NOT NULL,     -- Amazon's ID for the entity
  campaign_type TEXT NOT NULL,     -- sponsoredProducts, etc.
  -- Metrics
  impressions   BIGINT NOT NULL DEFAULT 0,
  clicks        BIGINT NOT NULL DEFAULT 0,
  cost          NUMERIC(14,4) NOT NULL DEFAULT 0,
  sales_1d      NUMERIC(14,4) DEFAULT 0,
  sales_7d      NUMERIC(14,4) DEFAULT 0,
  sales_14d     NUMERIC(14,4) DEFAULT 0,
  sales_30d     NUMERIC(14,4) DEFAULT 0,
  orders_1d     INTEGER DEFAULT 0,
  orders_7d     INTEGER DEFAULT 0,
  orders_14d    INTEGER DEFAULT 0,
  orders_30d    INTEGER DEFAULT 0,
  units_sold    INTEGER DEFAULT 0,
  -- Computed (stored for query performance)
  ctr           NUMERIC(8,6) GENERATED ALWAYS AS (
    CASE WHEN impressions > 0 THEN clicks::numeric / impressions ELSE 0 END
  ) STORED,
  cpc           NUMERIC(10,4) GENERATED ALWAYS AS (
    CASE WHEN clicks > 0 THEN cost / clicks ELSE 0 END
  ) STORED,
  acos_14d      NUMERIC(8,4) GENERATED ALWAYS AS (
    CASE WHEN sales_14d > 0 THEN cost / sales_14d * 100 ELSE NULL END
  ) STORED,
  roas_14d      NUMERIC(10,4) GENERATED ALWAYS AS (
    CASE WHEN cost > 0 THEN sales_14d / cost ELSE NULL END
  ) STORED,
  -- Metadata
  report_id     UUID,              -- which report request produced this row
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, date)
) PARTITION BY RANGE (date);

-- Create partitions: current year + next year
DO $$
DECLARE
  yr INTEGER;
BEGIN
  FOR yr IN 2024..2026 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS fact_metrics_daily_%s PARTITION OF fact_metrics_daily FOR VALUES FROM (''%s-01-01'') TO (''%s-01-01'')',
      yr, yr, yr + 1
    );
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_metrics_workspace_date ON fact_metrics_daily(workspace_id, date);
CREATE INDEX IF NOT EXISTS idx_metrics_profile_date ON fact_metrics_daily(profile_id, date);
CREATE INDEX IF NOT EXISTS idx_metrics_entity ON fact_metrics_daily(entity_id, date);
CREATE INDEX IF NOT EXISTS idx_metrics_amazon_id ON fact_metrics_daily(amazon_id, date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_metrics_unique ON fact_metrics_daily(profile_id, amazon_id, entity_type, date);

-- ─── Reports ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS report_requests (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id),
  profile_id          UUID NOT NULL REFERENCES amazon_profiles(id),
  amazon_report_id    TEXT,                            -- Amazon's reportId from v3 API
  report_type         TEXT NOT NULL,                   -- spCampaigns, sbCampaigns, etc.
  campaign_type       TEXT NOT NULL,                   -- SP, SB, SD
  date_start          DATE NOT NULL,
  date_end            DATE NOT NULL,
  granularity         TEXT NOT NULL DEFAULT 'DAY',
  metrics             TEXT[] NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending', -- pending, requested, processing, completed, failed
  s3_key              TEXT,                            -- path to raw file in object storage
  row_count           INTEGER,
  requested_at        TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  error_message       TEXT,
  retry_count         INTEGER NOT NULL DEFAULT 0,
  triggered_by        TEXT DEFAULT 'scheduler',        -- scheduler, user, api
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_workspace ON report_requests(workspace_id, date_start);
CREATE INDEX IF NOT EXISTS idx_reports_status ON report_requests(status);
CREATE INDEX IF NOT EXISTS idx_reports_profile ON report_requests(profile_id, date_start);

-- ─── Audit Log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_events (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL,
  workspace_id  UUID,
  actor_id      UUID,
  actor_type    TEXT NOT NULL DEFAULT 'user',          -- user, system, ai
  actor_name    TEXT,
  action        TEXT NOT NULL,                         -- e.g., campaign.update, keyword.bid_change
  entity_type   TEXT,                                  -- campaign, keyword, ad_group, etc.
  entity_id     TEXT,                                  -- UUID or Amazon ID
  entity_name   TEXT,
  before_data   JSONB,
  after_data    JSONB,
  diff          JSONB,                                 -- computed diff
  source        TEXT NOT NULL DEFAULT 'ui',            -- ui, api, ai, system
  request_id    TEXT,
  ip_address    INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NOTE: No updates/deletes allowed on this table (enforced by trigger)
);

CREATE INDEX IF NOT EXISTS idx_audit_workspace ON audit_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id);

-- Prevent updates and deletes on audit_events
CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit log is immutable. Updates and deletes are not allowed.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();

-- ─── Rules ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rules (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  conditions    JSONB NOT NULL,                        -- DSL conditions
  actions       JSONB NOT NULL,                        -- DSL actions
  schedule      TEXT NOT NULL DEFAULT '0 8 * * *',    -- cron expression
  scope         JSONB NOT NULL DEFAULT '{}',           -- campaign filters
  safety        JSONB NOT NULL DEFAULT '{"max_change_pct": 20, "min_bid": 0.02, "max_bid": 50}',
  dry_run       BOOLEAN NOT NULL DEFAULT FALSE,
  last_run_at   TIMESTAMPTZ,
  last_run_result JSONB,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Alerts ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_configs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  alert_type    TEXT NOT NULL,                         -- acos_threshold, roas_drop, etc.
  conditions    JSONB NOT NULL,
  channels      JSONB NOT NULL DEFAULT '{"in_app": true}',
  suppression_hours INTEGER NOT NULL DEFAULT 24,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_instances (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  config_id       UUID NOT NULL REFERENCES alert_configs(id) ON DELETE CASCADE,
  workspace_id    UUID NOT NULL,
  severity        TEXT NOT NULL DEFAULT 'medium',      -- low, medium, high, critical
  title           TEXT NOT NULL,
  message         TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  entity_name     TEXT,
  data            JSONB,
  status          TEXT NOT NULL DEFAULT 'open',        -- open, acknowledged, resolved
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_instances_workspace ON alert_instances(workspace_id, status, created_at DESC);

-- ─── AI Recommendations ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_recommendations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id          UUID,                                -- batch run that generated these
  type            TEXT NOT NULL,                       -- bid_increase, bid_decrease, add_negative, etc.
  title           TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  expected_effect TEXT,
  risk_level      TEXT NOT NULL DEFAULT 'medium',      -- low, medium, high
  actions         JSONB NOT NULL,                      -- strict schema: [{action_type, entity_type, entity_id, params}]
  context_snapshot JSONB,                              -- metrics snapshot used for generation (PII-free)
  status          TEXT NOT NULL DEFAULT 'pending',     -- pending, applied, dismissed, expired
  applied_at      TIMESTAMPTZ,
  applied_by      UUID REFERENCES users(id),
  dismissed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_recs_workspace ON ai_recommendations(workspace_id, status, created_at DESC);

-- ─── Sync State ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_state (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id        UUID NOT NULL REFERENCES amazon_profiles(id) ON DELETE CASCADE,
  entity_type       TEXT NOT NULL,                     -- campaigns, ad_groups, keywords, targets
  last_full_sync    TIMESTAMPTZ,
  last_sync_status  TEXT DEFAULT 'pending',
  sync_cursor       TEXT,                              -- pagination cursor if needed
  error_message     TEXT,
  UNIQUE (profile_id, entity_type)
);

-- ─── Helper: update updated_at automatically ─────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'organizations','users','workspaces','amazon_connections',
    'amazon_profiles','campaigns','ad_groups','keywords',
    'rules','alert_configs','report_requests'
  ]) LOOP
    EXECUTE format('
      CREATE TRIGGER trg_updated_at_%s
      BEFORE UPDATE ON %s
      FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
      tbl, tbl
    );
  END LOOP;
END $$;

-- ─── Seed: default org for development ───────────────────────────────────────
-- In production, remove this block
DO $$
BEGIN
  IF current_setting('app.env', true) != 'production' THEN
    INSERT INTO organizations(id, name, slug, plan)
    VALUES ('00000000-0000-0000-0000-000000000001', 'Dev Agency', 'dev-agency', 'pro')
    ON CONFLICT DO NOTHING;

    INSERT INTO workspaces(id, org_id, name)
    VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Brand Alpha')
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
