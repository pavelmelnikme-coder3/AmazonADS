-- Migration 003: rules and alerts refinements for Stage 2
-- Run: psql $DATABASE_URL -f 003_rules_alerts.sql

-- ─── Rules: add schedule_type for hourly/daily UI abstraction ─────────────────
ALTER TABLE rules ADD COLUMN IF NOT EXISTS schedule_type TEXT NOT NULL DEFAULT 'daily';

-- ─── Alert configs: add last_triggered_at for cooldown tracking ───────────────
ALTER TABLE alert_configs ADD COLUMN IF NOT EXISTS last_triggered_at TIMESTAMPTZ;

-- ─── Indexes for rule engine worker ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_rules_workspace_active ON rules(workspace_id, is_active);
CREATE INDEX IF NOT EXISTS idx_alert_configs_workspace_active ON alert_configs(workspace_id, is_active);
CREATE INDEX IF NOT EXISTS idx_keywords_state ON keywords(workspace_id, state);
