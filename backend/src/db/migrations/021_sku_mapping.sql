-- 021_sku_mapping.sql
-- SKU/ASIN cost configuration for analytics P&L report

CREATE TABLE IF NOT EXISTS sku_mapping (
  id                  SERIAL PRIMARY KEY,
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  asin                TEXT NOT NULL,
  sku                 TEXT NOT NULL DEFAULT '',
  label               INTEGER,
  product_name        TEXT NOT NULL DEFAULT '',
  cogs_per_unit       NUMERIC(10,4) NOT NULL DEFAULT 0,
  shipping_per_unit   NUMERIC(10,4) NOT NULL DEFAULT 0,
  amazon_fee_pct      NUMERIC(6,4)  NOT NULL DEFAULT -0.15,
  vat_pct             NUMERIC(6,4)  NOT NULL DEFAULT -0.19,
  google_ads_weekly   NUMERIC(10,2) NOT NULL DEFAULT 0,
  facebook_ads_weekly NUMERIC(10,2) NOT NULL DEFAULT 0,
  sellable_quota      INTEGER NOT NULL DEFAULT 0,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, asin)
);

CREATE INDEX IF NOT EXISTS idx_sku_mapping_workspace ON sku_mapping(workspace_id);
