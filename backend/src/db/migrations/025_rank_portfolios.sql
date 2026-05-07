CREATE TABLE IF NOT EXISTS rank_portfolios (
  id           SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  display_order INTEGER,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS rank_portfolios_ws_name ON rank_portfolios(workspace_id, name);
ALTER TABLE asin_labels ADD COLUMN IF NOT EXISTS portfolio_id INTEGER REFERENCES rank_portfolios(id) ON DELETE SET NULL;
