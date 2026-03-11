-- Migration 006: settings-related schema additions

ALTER TABLE workspaces       ADD COLUMN IF NOT EXISTS is_active    BOOLEAN    DEFAULT true;
ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS invited_by   UUID       REFERENCES users(id);
ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS invited_at   TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE users            ADD COLUMN IF NOT EXISTS avatar_url   TEXT;
ALTER TABLE users            ADD COLUMN IF NOT EXISTS timezone     TEXT       DEFAULT 'UTC';
ALTER TABLE users            ADD COLUMN IF NOT EXISTS locale       TEXT       DEFAULT 'en';
