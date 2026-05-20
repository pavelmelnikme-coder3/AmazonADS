-- Soft-delete trash bin: deleted entities are kept here for 30 days before permanent removal.
-- entity_type: 'rule' | 'alert' | ...  (extensible)
-- data: full JSON snapshot of the deleted row, enough to fully restore it
CREATE TABLE IF NOT EXISTS trash (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type  TEXT        NOT NULL,
  entity_id    UUID        NOT NULL,
  entity_name  TEXT,
  data         JSONB       NOT NULL,
  deleted_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
  deleted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
);
CREATE INDEX IF NOT EXISTS idx_trash_workspace ON trash(workspace_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_trash_entity    ON trash(entity_type, entity_id);
