-- Keyword Research search history — workspace-shared, team-visible.
-- Each row is one discovery run: the inputs + a full snapshot of the results,
-- so a past search can be restored instantly without re-querying paid sources
-- (Jungle Scout / Claude AI). Pruned to the latest 50 per workspace on insert.
CREATE TABLE IF NOT EXISTS kwr_search_history (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  profile_id    UUID,                          -- local profile UUID (no FK: survives profile detach)
  profile_name  TEXT,
  locale        TEXT,
  sources       JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- requested sources
  organic_top_n INTEGER,
  asins         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  product_title TEXT,
  url_input     TEXT,                          -- raw competitor-URL textarea (for restore)
  ad_group_id   UUID,
  total         INTEGER     NOT NULL DEFAULT 0,
  sources_used  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  result        JSONB,                         -- full snapshot { keywords, product_title, sources_used, total, jungle_scout_available }
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kwr_history_ws ON kwr_search_history(workspace_id, created_at DESC);
