-- Campaign exemptions: globally exclude campaigns from all rules
-- with optional expiry date (NULL = permanent until manually removed)
CREATE TABLE IF NOT EXISTS campaign_exemptions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id)  ON DELETE CASCADE,
  campaign_id   UUID        NOT NULL REFERENCES campaigns(id)   ON DELETE CASCADE,
  expires_at    TIMESTAMPTZ,
  reason        TEXT,
  created_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_exemptions_workspace ON campaign_exemptions(workspace_id);
