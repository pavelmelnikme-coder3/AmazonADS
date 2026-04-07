-- Add amazon_status / amazon_error columns to audit_events
ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS amazon_status TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS amazon_error  TEXT DEFAULT NULL;

-- Relax the immutability trigger to allow updating ONLY these two new columns
CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Audit events cannot be deleted';
  END IF;
  -- Allow UPDATE only when every core column is unchanged (only status columns differ)
  IF NEW.id            = OLD.id
     AND NEW.org_id    = OLD.org_id
     AND NEW.workspace_id   IS NOT DISTINCT FROM OLD.workspace_id
     AND NEW.actor_id       IS NOT DISTINCT FROM OLD.actor_id
     AND NEW.actor_type     = OLD.actor_type
     AND NEW.actor_name     IS NOT DISTINCT FROM OLD.actor_name
     AND NEW.action         = OLD.action
     AND NEW.entity_type    IS NOT DISTINCT FROM OLD.entity_type
     AND NEW.entity_id      IS NOT DISTINCT FROM OLD.entity_id
     AND NEW.entity_name    IS NOT DISTINCT FROM OLD.entity_name
     AND NEW.before_data    IS NOT DISTINCT FROM OLD.before_data
     AND NEW.after_data     IS NOT DISTINCT FROM OLD.after_data
     AND NEW.diff           IS NOT DISTINCT FROM OLD.diff
     AND NEW.source         = OLD.source
     AND NEW.created_at     = OLD.created_at
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Audit events are immutable';
END;
$$ LANGUAGE plpgsql;
