ALTER TABLE rules ADD COLUMN IF NOT EXISTS sort_order INTEGER;

UPDATE rules r SET sort_order = sub.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created_at ASC) AS rn
  FROM rules
) sub
WHERE r.id = sub.id AND r.sort_order IS NULL;

CREATE INDEX IF NOT EXISTS idx_rules_workspace_sort ON rules(workspace_id, sort_order);
