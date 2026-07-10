-- Listing health: per-ASIN check against Amazon's own published "listing improvement
-- recommendations" criteria (title length, image count/zoom, bullets, description,
-- A+ content). Amazon's own recommendation UI (Ads console → ad group → "Listing
-- improvement recommendations") has no public API, so we compute the same checks
-- ourselves from SP-API Catalog Items + A+ Content data. One row per product,
-- overwritten on each check (no history needed — unlike bsr_snapshots).
CREATE TABLE IF NOT EXISTS product_listing_health (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         UUID NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  title_len          INTEGER,
  bullet_count       INTEGER,
  image_count        INTEGER,
  has_zoomable_image BOOLEAN,
  has_description    BOOLEAN,
  has_aplus          BOOLEAN,
  issues             JSONB NOT NULL DEFAULT '[]',
  issue_count        INTEGER NOT NULL DEFAULT 0,
  raw_data           JSONB,
  checked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_listing_health_issue_count ON product_listing_health (issue_count DESC);
