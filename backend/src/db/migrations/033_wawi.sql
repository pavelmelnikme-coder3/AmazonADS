-- JTL-Wawi integration (Phase 1) — READ-ONLY ingest of the ERP data.
-- All Wawi data lives in its own `wawi_*` namespace and NEVER mutates the
-- Amazon-derived tables (products / sp_orders / fact_metrics_daily). The bridge
-- to Amazon is the ASIN (wawi_item_asins → products), resolved at sync time and
-- joined read-only. Wawi values are an additional, source-tagged truth (true
-- cost/margin, real stock, all-channel demand) alongside the Amazon data.

-- ─── Connection (OnPrem app registration + encrypted API key) ─────────────────
CREATE TABLE IF NOT EXISTS wawi_connections (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  base_url       TEXT        NOT NULL,                  -- e.g. http://5.175.24.47:64110/api/eazybusiness
  app_id         TEXT        NOT NULL,                  -- x-appid (e.g. AdsFlowWawi/1.0.0)
  app_version    TEXT        NOT NULL DEFAULT '1.0.0',  -- x-appversion
  api_version    TEXT        NOT NULL DEFAULT '1.1',    -- api-version header
  challenge_code TEXT        NOT NULL,                  -- x-challengecode (set at registration)
  registration_id TEXT,                                 -- RegistrationRequestId
  api_key_enc    TEXT,                                  -- AES-256-GCM encrypted Wawi API key (secret)
  granted_scopes JSONB       NOT NULL DEFAULT '[]'::jsonb,
  wawi_version   TEXT,                                  -- /info Version (e.g. 1.11.7)
  status         TEXT        NOT NULL DEFAULT 'active', -- active | revoked | error
  last_sync_at   TIMESTAMPTZ,
  error_count    INTEGER     NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wawi_connections_ws ON wawi_connections(workspace_id);

-- ─── Reference: warehouses & sales channels ───────────────────────────────────
CREATE TABLE IF NOT EXISTS wawi_warehouses (
  workspace_id UUID    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  wawi_id      BIGINT  NOT NULL,
  name         TEXT,
  type         TEXT,
  raw_data     JSONB,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, wawi_id)
);

CREATE TABLE IF NOT EXISTS wawi_sales_channels (
  workspace_id UUID    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  wawi_id      BIGINT  NOT NULL,
  name         TEXT,
  type         TEXT,                                    -- amazon | ebay | otto | shop | manual ...
  raw_data     JSONB,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, wawi_id)
);

-- ─── Items (product master + cost + identifiers) ──────────────────────────────
CREATE TABLE IF NOT EXISTS wawi_items (
  workspace_id        UUID    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  wawi_id             BIGINT  NOT NULL,
  sku                 TEXT,
  name                TEXT,
  manufacturer_id     BIGINT,
  manufacturer_number TEXT,
  is_active           BOOLEAN,
  parent_item_id      BIGINT,                            -- 0 = top-level
  gtin                TEXT,                              -- EAN/GTIN
  asins               JSONB   NOT NULL DEFAULT '[]'::jsonb,  -- Identifiers.Asins[]
  amazon_fnsku        TEXT,
  sales_price_net     NUMERIC(14,4),
  suggested_retail    NUMERIC(14,4),
  purchase_price_net  NUMERIC(14,4),                     -- COST — the key value Amazon never gives
  amazon_price        NUMERIC(14,4),
  tax_class_id        BIGINT,
  categories          JSONB,
  dimensions          JSONB,
  weights             JSONB,
  active_sales_channels JSONB,
  added_at            TIMESTAMPTZ,
  changed_at          TIMESTAMPTZ,                       -- Wawi "Changed" — drives changedSince delta sync
  raw_data            JSONB,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, wawi_id)
);
CREATE INDEX IF NOT EXISTS idx_wawi_items_sku     ON wawi_items(workspace_id, sku);
CREATE INDEX IF NOT EXISTS idx_wawi_items_gtin    ON wawi_items(workspace_id, gtin);
CREATE INDEX IF NOT EXISTS idx_wawi_items_changed ON wawi_items(workspace_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_wawi_items_asins   ON wawi_items USING GIN (asins);

-- Bridge: one row per (item, ASIN); product_id resolved from products by ASIN (nullable).
-- This is the read-only join key between Wawi and Amazon. Never writes to products.
CREATE TABLE IF NOT EXISTS wawi_item_asins (
  workspace_id UUID   NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  asin         TEXT   NOT NULL,
  wawi_item_id BIGINT NOT NULL,
  product_id   UUID   REFERENCES products(id) ON DELETE SET NULL,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, asin, wawi_item_id)
);
CREATE INDEX IF NOT EXISTS idx_wawi_item_asins_item    ON wawi_item_asins(workspace_id, wawi_item_id);
CREATE INDEX IF NOT EXISTS idx_wawi_item_asins_product ON wawi_item_asins(product_id);

-- ─── Stock (real inventory per warehouse/location) ────────────────────────────
CREATE TABLE IF NOT EXISTS wawi_stocks (
  workspace_id        UUID    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  wawi_item_id        BIGINT  NOT NULL,
  warehouse_id        BIGINT  NOT NULL,
  storage_location_id BIGINT  NOT NULL DEFAULT 0,
  storage_location    TEXT,
  quantity_total      NUMERIC(14,3) NOT NULL DEFAULT 0,
  qty_locked_shipment NUMERIC(14,3) NOT NULL DEFAULT 0,
  qty_locked_avail    NUMERIC(14,3) NOT NULL DEFAULT 0,
  qty_in_picking      NUMERIC(14,3) NOT NULL DEFAULT 0,
  raw_data            JSONB,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, wawi_item_id, warehouse_id, storage_location_id)
);
CREATE INDEX IF NOT EXISTS idx_wawi_stocks_item ON wawi_stocks(workspace_id, wawi_item_id);

-- Stock movements (incoming goods / "новые поступления" surface as positive changes).
CREATE TABLE IF NOT EXISTS wawi_stock_changes (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  UUID    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  wawi_item_id  BIGINT  NOT NULL,
  warehouse_id  BIGINT,
  change_date   TIMESTAMPTZ,
  quantity      NUMERIC(14,3),                           -- signed (+ incoming, − outgoing)
  change_type   TEXT,
  comment       TEXT,
  raw_data      JSONB,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, wawi_item_id, change_date, quantity, change_type)
);
CREATE INDEX IF NOT EXISTS idx_wawi_stock_changes_item ON wawi_stock_changes(workspace_id, wawi_item_id, change_date DESC);

-- ─── Sales orders (ALL channels — Amazon + eBay + OTTO + shop …) ──────────────
CREATE TABLE IF NOT EXISTS wawi_sales_orders (
  workspace_id    UUID    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  wawi_id         BIGINT  NOT NULL,
  number          TEXT,
  external_number TEXT,
  company_id      BIGINT,
  customer_id     BIGINT,
  sales_channel_id BIGINT,
  order_date      TIMESTAMPTZ,
  departure_country TEXT,
  payment_status  TEXT,
  is_cancelled    BOOLEAN NOT NULL DEFAULT FALSE,
  is_external_invoice BOOLEAN,
  raw_data        JSONB,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, wawi_id)
);
CREATE INDEX IF NOT EXISTS idx_wawi_orders_date    ON wawi_sales_orders(workspace_id, order_date);
CREATE INDEX IF NOT EXISTS idx_wawi_orders_channel ON wawi_sales_orders(workspace_id, sales_channel_id);

CREATE TABLE IF NOT EXISTS wawi_sales_order_items (
  workspace_id  UUID    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_wawi_id BIGINT  NOT NULL,
  line_id       BIGINT  NOT NULL,
  wawi_item_id  BIGINT,
  sku           TEXT,
  name          TEXT,
  quantity      NUMERIC(14,3),
  unit_price_net NUMERIC(14,4),
  raw_data      JSONB,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, order_wawi_id, line_id)
);
CREATE INDEX IF NOT EXISTS idx_wawi_order_items_item ON wawi_sales_order_items(workspace_id, wawi_item_id);

-- ─── Customers & suppliers ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wawi_customers (
  workspace_id UUID    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  wawi_id      BIGINT  NOT NULL,
  number       TEXT,
  company      TEXT,
  first_name   TEXT,
  last_name    TEXT,
  email        TEXT,
  country      TEXT,
  group_id     BIGINT,
  changed_at   TIMESTAMPTZ,
  raw_data     JSONB,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, wawi_id)
);

CREATE TABLE IF NOT EXISTS wawi_suppliers (
  workspace_id UUID    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  wawi_id      BIGINT  NOT NULL,
  name         TEXT,
  raw_data     JSONB,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, wawi_id)
);

-- ─── Incremental-sync cursors (one row per entity per connection) ─────────────
CREATE TABLE IF NOT EXISTS wawi_sync_state (
  workspace_id  UUID    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity        TEXT    NOT NULL,                        -- items | stocks | orders | customers ...
  cursor_value  TEXT,                                    -- last changedSince / createdSince watermark
  last_run_at   TIMESTAMPTZ,
  last_status   TEXT,
  rows_synced   INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  PRIMARY KEY (workspace_id, entity)
);
