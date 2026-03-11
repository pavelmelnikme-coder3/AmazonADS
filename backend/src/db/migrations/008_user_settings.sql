-- Migration 008: Add settings column to users table
CREATE OR REPLACE FUNCTION noop() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;
SELECT noop();
ALTER TABLE users ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}';
DROP FUNCTION noop();
