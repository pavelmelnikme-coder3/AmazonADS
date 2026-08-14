-- Cross-country listing check: the same ASIN as it appears in every EU marketplace
-- the seller participates in. Deliberately a SEPARATE table from
-- product_listing_health (which stays one-row-per-product for the home
-- marketplace) so the Products page queries are untouched and `products` does
-- not get 9x more rows — a products row per country would break every
-- per-ASIN aggregate that joins on (workspace_id, asin, marketplace_id).
--
-- One row per (product, marketplace). `exists_in_catalog=false` means SP-API
-- Catalog Items returned 404 NOT_FOUND for that marketplace — i.e. the ASIN is
-- genuinely not listed there, which is itself the most valuable finding.
CREATE TABLE IF NOT EXISTS product_marketplace_listings (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  marketplace_id     TEXT NOT NULL,
  country_code       TEXT NOT NULL,
  is_reference       BOOLEAN NOT NULL DEFAULT FALSE,
  exists_in_catalog  BOOLEAN NOT NULL DEFAULT FALSE,
  title              TEXT,
  title_len          INTEGER,
  bullet_count       INTEGER,
  image_count        INTEGER,
  has_zoomable_image BOOLEAN,
  has_description    BOOLEAN,
  has_aplus          BOOLEAN,
  best_rank          INTEGER,
  best_category      TEXT,
  issues             JSONB   NOT NULL DEFAULT '[]',
  issue_count        INTEGER NOT NULL DEFAULT 0,
  raw_data           JSONB,
  error_message      TEXT,
  checked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, marketplace_id)
);
CREATE INDEX IF NOT EXISTS idx_pml_product   ON product_marketplace_listings (product_id);
CREATE INDEX IF NOT EXISTS idx_pml_country   ON product_marketplace_listings (country_code);
CREATE INDEX IF NOT EXISTS idx_pml_issues    ON product_marketplace_listings (issue_count DESC);
CREATE INDEX IF NOT EXISTS idx_pml_missing   ON product_marketplace_listings (exists_in_catalog) WHERE exists_in_catalog = FALSE;
