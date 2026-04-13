-- 019_asin_labels.sql
-- Per-ASIN user labels for Rank Tracker

CREATE TABLE IF NOT EXISTS asin_labels (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  asin         TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, asin)
);

CREATE INDEX IF NOT EXISTS idx_asin_labels_workspace ON asin_labels(workspace_id);
