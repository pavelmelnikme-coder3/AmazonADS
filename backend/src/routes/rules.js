/**
 * Rules Engine Routes
 * GET    /rules                   — list with pagination
 * POST   /rules                   — create
 * PATCH  /rules/:id               — update
 * DELETE /rules/:id               — delete
 * POST   /rules/:id/run           — execute rule synchronously (dry_run flag)
 * GET    /rules/campaigns         — campaigns list for scope selector
 * GET    /rules/ad-groups         — ad-groups list (optionally filtered by campaignId)
 */

const express = require("express");
const router  = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const logger  = require("../config/logger");

router.use(requireAuth, requireWorkspace);

// ── Condition operators ───────────────────────────────────────────────────────
function evaluate(conditions, metrics) {
  return conditions.every(cond => {
    const val       = parseFloat(metrics[cond.metric] ?? 0);
    const threshold = parseFloat(cond.value);
    switch (cond.op) {
      case "gt":  return val >  threshold;
      case "gte": return val >= threshold;
      case "lt":  return val <  threshold;
      case "lte": return val <= threshold;
      case "eq":  return val === threshold;
      case "neq": return val !== threshold;
      default:    return false;
    }
  });
}

// ── Execute rule synchronously ────────────────────────────────────────────────
async function executeRule(rule, workspaceId, dryRun = false) {
  const conditions = typeof rule.conditions === "string" ? JSON.parse(rule.conditions) : rule.conditions;
  const actions    = typeof rule.actions    === "string" ? JSON.parse(rule.actions)    : rule.actions;
  const scope      = typeof rule.scope      === "string" ? JSON.parse(rule.scope)      : (rule.scope  || {});
  const safety     = typeof rule.safety     === "string" ? JSON.parse(rule.safety)     : (rule.safety || {});

  const endDate   = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - 14 * 86400000).toISOString().split("T")[0];

  // Build keyword filter from scope
  const kConds  = ["k.workspace_id = $1"];
  const kParams = [workspaceId];
  let pi = 2;

  if (scope.campaign_ids?.length) {
    kConds.push(`k.campaign_id = ANY($${pi++}::uuid[])`);
    kParams.push(scope.campaign_ids);
  }
  if (scope.ad_group_ids?.length) {
    kConds.push(`k.ad_group_id = ANY($${pi++}::uuid[])`);
    kParams.push(scope.ad_group_ids);
  }
  if (scope.campaign_type) {
    kConds.push(`c.campaign_type = $${pi++}`);
    kParams.push(scope.campaign_type);
  }
  if (scope.match_types?.length) {
    kConds.push(`k.match_type = ANY($${pi++}::text[])`);
    kParams.push(scope.match_types);
  }
  kConds.push("k.state != 'archived'");

  const { rows: keywords } = await query(
    `SELECT
       k.id, k.keyword_text, k.match_type, k.state, k.bid,
       k.campaign_id, k.ad_group_id,
       c.name  AS campaign_name, c.campaign_type,
       ag.name AS ad_group_name,
       COALESCE(SUM(m.clicks), 0)      AS clicks,
       COALESCE(SUM(m.cost),   0)      AS spend,
       COALESCE(SUM(m.sales_14d), 0)   AS sales,
       COALESCE(SUM(m.orders_14d), 0)  AS orders,
       COALESCE(SUM(m.impressions), 0) AS impressions,
       CASE WHEN COALESCE(SUM(m.sales_14d),0) > 0
            THEN SUM(m.cost)/SUM(m.sales_14d)*100 END  AS acos,
       CASE WHEN COALESCE(SUM(m.cost),0) > 0
            THEN SUM(m.sales_14d)/SUM(m.cost) END       AS roas,
       CASE WHEN COALESCE(SUM(m.impressions),0) > 0
            THEN SUM(m.clicks)::numeric/SUM(m.impressions)*100 END AS ctr,
       CASE WHEN COALESCE(SUM(m.clicks),0) > 0
            THEN SUM(m.cost)/SUM(m.clicks) END          AS cpc
     FROM keywords k
     JOIN campaigns  c  ON c.id  = k.campaign_id
     JOIN ad_groups  ag ON ag.id = k.ad_group_id
     LEFT JOIN fact_metrics_daily m
       ON m.entity_id = k.id AND m.entity_type = 'keyword'
       AND m.date BETWEEN $${pi++} AND $${pi++}
     WHERE ${kConds.join(" AND ")}
     GROUP BY k.id, k.keyword_text, k.match_type, k.state, k.bid,
              k.campaign_id, k.ad_group_id, c.name, c.campaign_type, ag.name`,
    [...kParams, startDate, endDate]
  );

  const matched = keywords.filter(kw => evaluate(conditions, kw));
  const applied = [];
  const errors  = [];

  for (const kw of matched) {
    for (const action of actions) {
      try {
        if (action.type === "pause_keyword") {
          if (kw.state === "paused") continue;
          if (!dryRun) {
            await query("UPDATE keywords SET state = 'paused', updated_at = NOW() WHERE id = $1", [kw.id]);
          }
          applied.push({
            keyword_id: kw.id, keyword_text: kw.keyword_text,
            campaign_name: kw.campaign_name, ad_group_name: kw.ad_group_name,
            action: "pause_keyword", previous_state: kw.state, new_state: "paused",
            metrics: { clicks: kw.clicks, spend: kw.spend, sales: kw.sales, orders: kw.orders, acos: kw.acos },
          });
        } else if (action.type === "enable_keyword") {
          if (kw.state === "enabled") continue;
          if (!dryRun) {
            await query("UPDATE keywords SET state = 'enabled', updated_at = NOW() WHERE id = $1", [kw.id]);
          }
          applied.push({
            keyword_id: kw.id, keyword_text: kw.keyword_text,
            campaign_name: kw.campaign_name, ad_group_name: kw.ad_group_name,
            action: "enable_keyword", previous_state: kw.state, new_state: "enabled",
            metrics: { clicks: kw.clicks, spend: kw.spend, sales: kw.sales },
          });
        } else if (action.type === "adjust_bid_pct") {
          const pct        = parseFloat(action.value || 0) / 100;
          const currentBid = parseFloat(kw.bid || 0.10);
          const minBid     = parseFloat(safety.min_bid || 0.02);
          const maxBid     = parseFloat(safety.max_bid || 50);
          let newBid = Math.round(Math.max(minBid, Math.min(maxBid, currentBid * (1 + pct))) * 100) / 100;
          if (!dryRun) {
            await query("UPDATE keywords SET bid = $1, updated_at = NOW() WHERE id = $2", [newBid, kw.id]);
          }
          applied.push({
            keyword_id: kw.id, keyword_text: kw.keyword_text,
            campaign_name: kw.campaign_name, ad_group_name: kw.ad_group_name,
            action: "adjust_bid_pct", previous_bid: currentBid, new_bid: newBid,
            change_pct: (pct * 100).toFixed(1) + "%",
          });
        } else if (action.type === "set_bid") {
          const newBid = parseFloat(action.value || 0.10);
          if (!dryRun) {
            await query("UPDATE keywords SET bid = $1, updated_at = NOW() WHERE id = $2", [newBid, kw.id]);
          }
          applied.push({
            keyword_id: kw.id, keyword_text: kw.keyword_text,
            campaign_name: kw.campaign_name, action: "set_bid",
            previous_bid: kw.bid, new_bid: newBid,
          });
        }
      } catch (e) {
        errors.push({ keyword_id: kw.id, error: e.message });
      }
    }
  }

  return {
    matched_count:    matched.length,
    total_evaluated:  keywords.length,
    applied_count:    applied.length,
    dry_run:          dryRun,
    period:           { start: startDate, end: endDate },
    applied,
    errors,
  };
}

// ── GET /rules/campaigns — MUST be before /:id to avoid param capture ─────────
router.get("/campaigns", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, campaign_type, state FROM campaigns
       WHERE workspace_id = $1 AND state != 'archived'
       ORDER BY name ASC LIMIT 200`,
      [req.workspaceId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /rules/ad-groups — MUST be before /:id ────────────────────────────────
router.get("/ad-groups", async (req, res, next) => {
  try {
    const { campaignId } = req.query;
    const cond   = ["ag.workspace_id = $1"];
    const params = [req.workspaceId];
    if (campaignId) { cond.push("ag.campaign_id = $2"); params.push(campaignId); }
    const { rows } = await query(
      `SELECT ag.id, ag.name, ag.campaign_id, c.name AS campaign_name
       FROM ad_groups ag JOIN campaigns c ON c.id = ag.campaign_id
       WHERE ${cond.join(" AND ")} AND ag.state != 'archived'
       ORDER BY c.name, ag.name LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /rules — list with pagination ────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || 25), 100);
    const page   = Math.max(parseInt(req.query.page   || 1), 1);
    const offset = (page - 1) * limit;

    const [{ rows }, { rows: [cnt] }] = await Promise.all([
      query(
        "SELECT * FROM rules WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
        [req.workspaceId, limit, offset]
      ),
      query("SELECT COUNT(*)::int AS count FROM rules WHERE workspace_id = $1", [req.workspaceId]),
    ]);

    res.json({
      data: rows,
      pagination: { total: cnt.count, page, limit, pages: Math.ceil(cnt.count / limit) },
    });
  } catch (err) { next(err); }
});

// ── POST /rules — create ──────────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const { name, description, conditions, actions, schedule, scope, safety, dry_run } = req.body;
    if (!name || !conditions?.length || !actions?.length) {
      return res.status(400).json({ error: "name, conditions and actions required" });
    }
    const { rows: [rule] } = await query(
      `INSERT INTO rules
         (workspace_id, name, description, conditions, actions, schedule, scope, safety, dry_run, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        req.workspaceId, name, description || "",
        JSON.stringify(conditions), JSON.stringify(actions),
        schedule || "0 8 * * *",
        JSON.stringify(scope   || {}),
        JSON.stringify(safety  || { min_bid: 0.02, max_bid: 50 }),
        dry_run || false, req.user.id,
      ]
    );
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

// ── PATCH /rules/:id — update ─────────────────────────────────────────────────
router.patch("/:id", async (req, res, next) => {
  try {
    const { name, description, conditions, actions, schedule, scope, safety, dry_run, is_active } = req.body;
    const { rows: [rule] } = await query(
      `UPDATE rules SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         conditions  = COALESCE($3::jsonb, conditions),
         actions     = COALESCE($4::jsonb, actions),
         schedule    = COALESCE($5, schedule),
         scope       = COALESCE($6::jsonb, scope),
         safety      = COALESCE($7::jsonb, safety),
         dry_run     = COALESCE($8, dry_run),
         is_active   = COALESCE($9, is_active),
         updated_at  = NOW()
       WHERE id = $10 AND workspace_id = $11
       RETURNING *`,
      [
        name, description,
        conditions ? JSON.stringify(conditions) : null,
        actions    ? JSON.stringify(actions)    : null,
        schedule,
        scope   ? JSON.stringify(scope)   : null,
        safety  ? JSON.stringify(safety)  : null,
        dry_run, is_active,
        req.params.id, req.workspaceId,
      ]
    );
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    res.json(rule);
  } catch (err) { next(err); }
});

// ── DELETE /rules/:id ─────────────────────────────────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    await query("DELETE FROM rules WHERE id = $1 AND workspace_id = $2", [req.params.id, req.workspaceId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /rules/:id/run — execute synchronously ───────────────────────────────
router.post("/:id/run", async (req, res, next) => {
  try {
    const { dry_run } = req.body;
    const { rows: [rule] } = await query(
      "SELECT * FROM rules WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    if (!rule) return res.status(404).json({ error: "Rule not found" });

    const effectiveDryRun = dry_run !== undefined ? dry_run : rule.dry_run;
    const result = await executeRule(rule, req.workspaceId, effectiveDryRun);

    await query(
      "UPDATE rules SET last_run_at = NOW(), last_run_result = $1 WHERE id = $2",
      [JSON.stringify(result), req.params.id]
    );

    logger.info("Rule executed", { ruleId: rule.id, ruleName: rule.name, ...result });
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
