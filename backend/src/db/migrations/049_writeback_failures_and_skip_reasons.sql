-- Rule write-backs that Amazon refuses must not leave the local row claiming the
-- negative is live.
--
-- Live case (2026-09-01): the rule negated "abdeckplane wohnmobil 7,50 m", Amazon
-- answered malformedValueError / PATTERN_NOT_MATCHED (the comma), and the local row
-- stayed state='enabled' with a synthetic "rule-…" id. Every later run then skipped the
-- term as `already_negative`, and reconciliation only ever asks "is this negative still
-- justified by the metrics", never "does it exist on Amazon" — so the term kept spending
-- with nothing blocking it and nothing retrying, indefinitely and silently.
--
-- The rule engine now rolls such a row back to 'archived' and records why here. A
-- permanent rejection (Amazon will refuse the same text again) is remembered so the rule
-- stops re-issuing a doomed write every day; a transient one (401/429/5xx/timeout) is
-- retried on the next run.
ALTER TABLE negative_keywords ADD COLUMN IF NOT EXISTS writeback_error      text;
ALTER TABLE negative_keywords ADD COLUMN IF NOT EXISTS writeback_failed_at  timestamptz;
ALTER TABLE negative_targets  ADD COLUMN IF NOT EXISTS writeback_error      text;
ALTER TABLE negative_targets  ADD COLUMN IF NOT EXISTS writeback_failed_at  timestamptz;

-- Rule runs that skipped every match looked identical to runs that broke: only the
-- `applied` list was persisted, so "30 matched / 0 actions" carried no reason at all. Live
-- example: the budget rule reported 30 matched / 0 actions three times in a week because no
-- campaign was actually budget-limited — correct behaviour that was indistinguishable from a
-- broken rule. The engine already computes both the per-entity skip reasons and the Amazon
-- rejections; they are now persisted next to the run.
ALTER TABLE rule_executions ADD COLUMN IF NOT EXISTS entities_skipped integer NOT NULL DEFAULT 0;
ALTER TABLE rule_executions ADD COLUMN IF NOT EXISTS diagnostics      jsonb   NOT NULL DEFAULT '{}'::jsonb;
