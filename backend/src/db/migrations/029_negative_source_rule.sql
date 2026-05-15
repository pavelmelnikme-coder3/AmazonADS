-- Track which rule created each negative, and enable state lifecycle tracking

ALTER TABLE negative_keywords
  ADD COLUMN IF NOT EXISTS source_rule_id  UUID REFERENCES rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_entity_type TEXT,
  ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'enabled';

ALTER TABLE negative_targets
  ADD COLUMN IF NOT EXISTS source_rule_id  UUID REFERENCES rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_entity_type TEXT,
  ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'enabled';

CREATE INDEX IF NOT EXISTS idx_neg_kw_source_rule  ON negative_keywords(source_rule_id)  WHERE source_rule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_neg_tgt_source_rule ON negative_targets(source_rule_id)   WHERE source_rule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_neg_kw_state        ON negative_keywords(workspace_id, state);
CREATE INDEX IF NOT EXISTS idx_neg_tgt_state       ON negative_targets(workspace_id, state);
