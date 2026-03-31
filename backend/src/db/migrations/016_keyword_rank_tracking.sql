-- Keyword rank tracking: track organic positions of keywords for specific ASINs

CREATE TABLE IF NOT EXISTS tracked_keywords (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  asin            TEXT NOT NULL,
  keyword         TEXT NOT NULL,
  marketplace_id  TEXT NOT NULL DEFAULT 'A1PA6795UKMFR9',
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (workspace_id, asin, keyword, marketplace_id)
);

CREATE INDEX IF NOT EXISTS idx_tracked_keywords_workspace
  ON tracked_keywords (workspace_id)
  WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS keyword_rank_snapshots (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_keyword_id  UUID NOT NULL REFERENCES tracked_keywords(id) ON DELETE CASCADE,
  position            INTEGER,    -- organic rank position, NULL = not found / blocked
  page                INTEGER,    -- which search page (1-3)
  found               BOOLEAN DEFAULT FALSE,
  blocked             BOOLEAN DEFAULT FALSE,  -- CAPTCHA / rate limited
  captured_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_krs_keyword_captured
  ON keyword_rank_snapshots (tracked_keyword_id, captured_at DESC);
