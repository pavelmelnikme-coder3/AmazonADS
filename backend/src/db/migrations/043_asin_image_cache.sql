-- Lightweight cache of Amazon catalog image + title for ASINs that are NOT tracked
-- in the products table (e.g. Wawi new-arrivals shown on the "new, not advertised"
-- tab). Lets that view display product photos/titles without auto-creating a tracked
-- products row and without hitting SP-API on every page load.
CREATE TABLE IF NOT EXISTS asin_image_cache (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  asin         TEXT NOT NULL,
  image_url    TEXT,
  title        TEXT,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, asin)
);
