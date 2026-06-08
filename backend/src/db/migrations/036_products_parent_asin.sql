-- Listing grouping: store the Amazon parent ASIN (variation family) per product.
-- Populated from SP-API Catalog Items relationships (type=VARIATION → parentAsins).
-- NULL = standalone listing or the parent itself; the listing key is COALESCE(parent_asin, asin).
ALTER TABLE products ADD COLUMN IF NOT EXISTS parent_asin text;
CREATE INDEX IF NOT EXISTS idx_products_parent_asin ON products (workspace_id, parent_asin);
