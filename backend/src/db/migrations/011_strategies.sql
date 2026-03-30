-- ─── Strategies (Algorithm Stacking / Rule Chains) ───────────────────────────
-- A strategy is an ordered set of rules executed in sequence.
-- Rules in a strategy run one after another, so earlier rules can affect
-- entities that later rules then evaluate (e.g. bid adjustment → then check ACOS).

CREATE TABLE IF NOT EXISTS strategies (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT,
  rule_ids          UUID[] NOT NULL DEFAULT '{}',   -- ordered list of rule UUIDs
  is_active         BOOLEAN NOT NULL DEFAULT true,
  last_run_at       TIMESTAMPTZ,
  last_run_status   TEXT DEFAULT 'never',           -- never, completed, error
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategies_workspace ON strategies(workspace_id, created_at DESC);

-- ─── Strategy Executions ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS strategy_executions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  strategy_id     UUID NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  workspace_id    UUID NOT NULL,
  dry_run         BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'completed',   -- completed, error
  rules_run       INT NOT NULL DEFAULT 0,
  total_actions   INT NOT NULL DEFAULT 0,
  error_message   TEXT,
  summary         JSONB,                               -- per-rule result summaries
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_strategy_executions_strategy ON strategy_executions(strategy_id, started_at DESC);
