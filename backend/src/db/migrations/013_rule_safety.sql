-- ─── Rule priority ────────────────────────────────────────────────────────────
-- 1 = lowest, 100 = highest, default 50
-- Rules are evaluated in descending priority order within each workspace run.
ALTER TABLE rules ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 50;

-- ─── Cross-run entity cooldowns ───────────────────────────────────────────────
-- Prevents multiple rules from touching the same entity+category within
-- Amazon's propagation window. One row per (workspace, entity, action_category).
-- action_category: 'bid' | 'budget' | 'state_change'
CREATE TABLE IF NOT EXISTS rule_entity_cooldowns (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id            UUID NOT NULL,
  entity_type          TEXT NOT NULL DEFAULT 'campaign',
  action_category      TEXT NOT NULL,
  locked_until         TIMESTAMPTZ NOT NULL,
  applied_by_rule_id   UUID REFERENCES rules(id) ON DELETE SET NULL,
  applied_by_rule_name TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (workspace_id, entity_id, action_category)
);

CREATE INDEX IF NOT EXISTS idx_rec_workspace_expiry
  ON rule_entity_cooldowns (workspace_id, locked_until);
