-- Migration 005: rule_executions table + rules columns for Stage 4
-- Also re-applies any columns from 003/004 that may have been missed
-- if the DB was initialised without those migrations running.

-- ─── Ensure all rules columns exist (idempotent) ─────────────────────────────
ALTER TABLE rules ADD COLUMN IF NOT EXISTS schedule_type  TEXT          NOT NULL DEFAULT 'daily';
ALTER TABLE rules ADD COLUMN IF NOT EXISTS schedule       TEXT          NOT NULL DEFAULT '0 8 * * *';
ALTER TABLE rules ADD COLUMN IF NOT EXISTS safety         JSONB         NOT NULL DEFAULT '{"max_change_pct":20,"min_bid":0.02,"max_bid":50}';
ALTER TABLE rules ADD COLUMN IF NOT EXISTS dry_run        BOOLEAN       NOT NULL DEFAULT false;
ALTER TABLE rules ADD COLUMN IF NOT EXISTS created_by     UUID;
ALTER TABLE rules ADD COLUMN IF NOT EXISTS last_run_at    TIMESTAMPTZ;
ALTER TABLE rules ADD COLUMN IF NOT EXISTS last_run_result JSONB;

-- ─── Stage 4 additions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rule_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID REFERENCES rules(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  entities_evaluated INTEGER DEFAULT 0,
  entities_matched INTEGER DEFAULT 0,
  actions_taken INTEGER DEFAULT 0,
  actions_failed INTEGER DEFAULT 0,
  dry_run BOOLEAN DEFAULT false,
  summary JSONB DEFAULT '[]',
  status VARCHAR(20) DEFAULT 'running',
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_rule_executions_rule ON rule_executions(rule_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_rule_executions_workspace ON rule_executions(workspace_id, started_at DESC);

ALTER TABLE rules ADD COLUMN IF NOT EXISTS last_run_status VARCHAR(20);
ALTER TABLE rules ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ;
ALTER TABLE rules ADD COLUMN IF NOT EXISTS run_count INTEGER DEFAULT 0;
