-- SP-API data tables: products, BSR, inventory, orders, financials, pricing

-- ─── Products (ASIN tracking) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  asin           TEXT NOT NULL,
  marketplace_id TEXT NOT NULL,
  title          TEXT,
  brand          TEXT,
  image_url      TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, asin, marketplace_id)
);
CREATE INDEX IF NOT EXISTS products_workspace_id_idx ON products(workspace_id);
CREATE INDEX IF NOT EXISTS products_active_idx ON products(workspace_id, is_active);

-- ─── BSR snapshots ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bsr_snapshots (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id            UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  classification_ranks  JSONB NOT NULL DEFAULT '[]',
  display_group_ranks   JSONB NOT NULL DEFAULT '[]',
  best_rank             INTEGER,
  best_category         TEXT,
  raw_data              JSONB,
  captured_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS bsr_snapshots_product_captured_idx ON bsr_snapshots(product_id, captured_at DESC);

-- ─── SP Inventory ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sp_inventory (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  asin                        TEXT NOT NULL,
  marketplace_id              TEXT NOT NULL,
  seller_sku                  TEXT NOT NULL DEFAULT '',
  condition                   TEXT,
  fulfillment_channel         TEXT NOT NULL DEFAULT '',
  quantity_total              INTEGER,
  quantity_sellable           INTEGER,
  quantity_reserved           INTEGER,
  quantity_pending_removal    INTEGER,
  inbound_working             INTEGER,
  inbound_shipped             INTEGER,
  inbound_receiving           INTEGER,
  researching_quantity        INTEGER,
  unfulfillable_quantity      INTEGER,
  raw_data                    JSONB NOT NULL DEFAULT '{}',
  synced_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, asin, marketplace_id, seller_sku, fulfillment_channel)
);
CREATE INDEX IF NOT EXISTS sp_inventory_workspace_idx ON sp_inventory(workspace_id);
CREATE INDEX IF NOT EXISTS sp_inventory_asin_idx ON sp_inventory(workspace_id, asin, marketplace_id);
CREATE INDEX IF NOT EXISTS sp_inventory_synced_idx ON sp_inventory(synced_at DESC);

-- ─── SP Orders ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sp_orders (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  amazon_order_id           TEXT NOT NULL,
  marketplace_id            TEXT NOT NULL,
  purchase_date             TIMESTAMPTZ,
  last_update_date          TIMESTAMPTZ,
  order_status              TEXT,
  fulfillment_channel       TEXT,
  sales_channel             TEXT,
  order_type                TEXT,
  number_of_items_shipped   INTEGER,
  number_of_items_unshipped INTEGER,
  order_total_amount        NUMERIC(14,4),
  order_total_currency      TEXT,
  is_business_order         BOOLEAN NOT NULL DEFAULT FALSE,
  is_prime                  BOOLEAN NOT NULL DEFAULT FALSE,
  is_premium_order          BOOLEAN NOT NULL DEFAULT FALSE,
  is_replacement_order      BOOLEAN NOT NULL DEFAULT FALSE,
  buyer_email               TEXT,
  ship_city                 TEXT,
  ship_state                TEXT,
  ship_country              TEXT,
  ship_postal_code          TEXT,
  promised_delivery_date    TIMESTAMPTZ,
  earliest_ship_date        TIMESTAMPTZ,
  latest_ship_date          TIMESTAMPTZ,
  raw_data                  JSONB NOT NULL DEFAULT '{}',
  fetched_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, amazon_order_id)
);
CREATE INDEX IF NOT EXISTS sp_orders_workspace_idx ON sp_orders(workspace_id);
CREATE INDEX IF NOT EXISTS sp_orders_date_idx ON sp_orders(workspace_id, purchase_date DESC);
CREATE INDEX IF NOT EXISTS sp_orders_status_idx ON sp_orders(order_status);
CREATE INDEX IF NOT EXISTS sp_orders_fulfillment_idx ON sp_orders(fulfillment_channel);

-- ─── SP Order Items ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sp_order_items (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                  UUID NOT NULL REFERENCES sp_orders(id) ON DELETE CASCADE,
  workspace_id              UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  amazon_order_item_id      TEXT NOT NULL,
  asin                      TEXT,
  seller_sku                TEXT,
  title                     TEXT,
  quantity_ordered          INTEGER,
  quantity_shipped          INTEGER,
  item_price_amount         NUMERIC(14,4),
  item_price_currency       TEXT,
  item_tax_amount           NUMERIC(14,4),
  shipping_price_amount     NUMERIC(14,4),
  shipping_discount_amount  NUMERIC(14,4),
  promotion_discount_amount NUMERIC(14,4),
  points_granted            INTEGER,
  condition_id              TEXT,
  condition_subtype         TEXT,
  is_gift                   BOOLEAN NOT NULL DEFAULT FALSE,
  is_transparency           BOOLEAN NOT NULL DEFAULT FALSE,
  raw_data                  JSONB NOT NULL DEFAULT '{}',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, amazon_order_item_id)
);
CREATE INDEX IF NOT EXISTS sp_order_items_order_idx ON sp_order_items(order_id);
CREATE INDEX IF NOT EXISTS sp_order_items_asin_idx ON sp_order_items(workspace_id, asin);

-- ─── SP Financials ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sp_financials (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  marketplace_id        TEXT,
  amazon_order_id       TEXT,
  posted_date           TIMESTAMPTZ,
  event_type            TEXT NOT NULL,
  event_group           TEXT,
  amount                NUMERIC(14,4),
  currency_code         TEXT,
  asin                  TEXT,
  seller_sku            TEXT,
  fulfillment_identifier TEXT,
  transaction_type      TEXT,
  quantity              INTEGER,
  description           TEXT,
  event_hash            TEXT,
  raw_data              JSONB NOT NULL DEFAULT '{}',
  fetched_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sp_financials_hash_idx ON sp_financials(event_hash) WHERE event_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS sp_financials_workspace_idx ON sp_financials(workspace_id);
CREATE INDEX IF NOT EXISTS sp_financials_date_idx ON sp_financials(workspace_id, posted_date DESC);
CREATE INDEX IF NOT EXISTS sp_financials_type_idx ON sp_financials(event_type);
CREATE INDEX IF NOT EXISTS sp_financials_order_idx ON sp_financials(amazon_order_id);

-- ─── SP Pricing ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sp_pricing (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  asin                    TEXT NOT NULL,
  marketplace_id          TEXT NOT NULL,
  item_condition          TEXT DEFAULT 'New',
  landed_price_amount     NUMERIC(14,4),
  landed_price_currency   TEXT,
  listing_price_amount    NUMERIC(14,4),
  listing_price_currency  TEXT,
  shipping_amount         NUMERIC(14,4),
  shipping_currency       TEXT,
  points                  INTEGER,
  buy_box_price_amount    NUMERIC(14,4),
  buy_box_price_currency  TEXT,
  buy_box_seller_id       TEXT,
  competitive_prices      JSONB NOT NULL DEFAULT '[]',
  offers_count            INTEGER,
  raw_data                JSONB NOT NULL DEFAULT '{}',
  captured_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sp_pricing_asin_idx ON sp_pricing(workspace_id, asin, marketplace_id);
CREATE INDEX IF NOT EXISTS sp_pricing_captured_idx ON sp_pricing(captured_at DESC);

-- ─── SP Sync Log ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sp_sync_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  marketplace_id   TEXT,
  sync_type        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'running',
  records_fetched  INTEGER NOT NULL DEFAULT 0,
  records_upserted INTEGER NOT NULL DEFAULT 0,
  next_token       TEXT,
  date_from        TEXT,
  date_to          TEXT,
  error_message    TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sp_sync_log_workspace_idx ON sp_sync_log(workspace_id, sync_type, started_at DESC);

-- ─── 2027 partition for fact_metrics_daily ────────────────────────────────────
CREATE TABLE IF NOT EXISTS fact_metrics_daily_2027
  PARTITION OF fact_metrics_daily
  FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');

-- ─── updated_at triggers ──────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'products_updated_at') THEN
    CREATE TRIGGER products_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'sp_inventory_updated_at') THEN
    CREATE TRIGGER sp_inventory_updated_at BEFORE UPDATE ON sp_inventory FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'sp_orders_updated_at') THEN
    CREATE TRIGGER sp_orders_updated_at BEFORE UPDATE ON sp_orders FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'sp_order_items_updated_at') THEN
    CREATE TRIGGER sp_order_items_updated_at BEFORE UPDATE ON sp_order_items FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;
