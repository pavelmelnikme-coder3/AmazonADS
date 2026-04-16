const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { put, post: apiPost } = require("../services/amazon/adsClient");
const { writeAudit } = require("./audit");
const logger = require("../config/logger");

const router = express.Router();
router.use(requireAuth, requireWorkspace);

// GET /targets — list targets with metrics
router.get("/", async (req, res, next) => {
  try {
    const {
      campaignId, adGroupId, state, expressionType,
      page = 1, limit: rawLimit = 500,
      sortBy = "spend", sortDir = "desc",
      metricsDays = 30,
    } = req.query;

    const limit     = Math.min(parseInt(rawLimit)   || 500, 2000);
    const offset    = (Math.max(parseInt(page), 1) - 1) * limit;
    const mInterval = Math.min(Math.max(parseInt(metricsDays) || 30, 1), 365);

    const conditions = ["t.workspace_id = $1"];
    const params = [req.workspaceId];
    let pi = 2;

    if (campaignId)     { conditions.push(`t.campaign_id  = $${pi++}`);    params.push(campaignId); }
    if (adGroupId)      { conditions.push(`t.ad_group_id  = $${pi++}`);    params.push(adGroupId); }
    if (state && state !== "all") { conditions.push(`t.state = $${pi++}`); params.push(state); }
    if (expressionType) { conditions.push(`t.expression_type = $${pi++}`); params.push(expressionType); }

    const where = "WHERE " + conditions.join(" AND ");

    const metricsJoin = `LEFT JOIN (
      SELECT amazon_id,
        SUM(impressions)  AS impressions,
        SUM(clicks)       AS clicks,
        SUM(cost)         AS cost,
        SUM(sales_14d)    AS sales_14d,
        SUM(orders_14d)   AS orders_14d,
        CASE WHEN SUM(sales_14d) > 0 THEN SUM(cost)/SUM(sales_14d)*100 END AS acos_14d,
        CASE WHEN SUM(cost)      > 0 THEN SUM(sales_14d)/SUM(cost)     END AS roas_14d,
        CASE WHEN SUM(clicks)    > 0 THEN SUM(cost)/SUM(clicks)        END AS cpc
      FROM fact_metrics_daily
      WHERE workspace_id = $1
        AND date >= NOW() - INTERVAL '${mInterval} days'
        AND entity_type = 'target'
      GROUP BY amazon_id
    ) m ON m.amazon_id = t.amazon_target_id`;

    const allowedSort = {
      spend:  "COALESCE(m.cost,0)",
      sales:  "COALESCE(m.sales_14d,0)",
      acos:   "m.acos_14d",
      roas:   "m.roas_14d",
      bid:    "t.bid",
      state:  "t.state",
      clicks: "COALESCE(m.clicks,0)",
      orders: "COALESCE(m.orders_14d,0)",
    };
    const orderField = allowedSort[sortBy] || "COALESCE(m.cost,0)";
    const orderDir   = sortDir === "asc" ? "ASC" : "DESC";

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT
           t.id, t.amazon_target_id, t.ad_type, t.expression_type,
           t.expression, t.resolved_expression, t.state, t.bid,
           t.campaign_id, t.ad_group_id,
           ag.name          AS ad_group_name,
           c.campaign_type,
           p.profile_id     AS amazon_profile_id,
           p.marketplace_id,
           conn.id          AS connection_id,
           COALESCE(m.impressions,0) AS impressions,
           COALESCE(m.clicks,0)     AS clicks,
           COALESCE(m.cost,0)       AS spend,
           COALESCE(m.sales_14d,0)  AS sales,
           COALESCE(m.orders_14d,0) AS orders,
           m.acos_14d AS acos,
           m.roas_14d AS roas,
           m.cpc
         FROM targets t
         JOIN ad_groups ag          ON ag.id   = t.ad_group_id
         JOIN campaigns c           ON c.id    = t.campaign_id
         JOIN amazon_profiles p     ON p.id    = t.profile_id
         JOIN amazon_connections conn ON conn.id = p.connection_id
         ${metricsJoin}
         ${where}
         ORDER BY ${orderField} ${orderDir} NULLS LAST
         LIMIT ${limit} OFFSET $${pi++}`,
        [...params, offset]
      ),
      query(
        `SELECT COUNT(*) AS total
         FROM targets t
         JOIN ad_groups ag ON ag.id = t.ad_group_id
         JOIN campaigns c  ON c.id  = t.campaign_id
         JOIN amazon_profiles p ON p.id = t.profile_id
         JOIN amazon_connections conn ON conn.id = p.connection_id
         ${metricsJoin}
         ${where}`,
        params
      ),
    ]);

    const total = parseInt(countRows[0].total);
    res.json({
      data: rows,
      pagination: { total, page: parseInt(page), limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
});

// POST /targets — create a manual ASIN/category target
router.post("/", async (req, res, next) => {
  try {
    const { adGroupId, expressionType = "asinSameAs", expressionValue, bid = 0.50 } = req.body;
    if (!adGroupId || !expressionValue?.trim())
      return res.status(400).json({ error: "adGroupId and expressionValue required" });
    const bidVal = Math.max(0.02, parseFloat(bid) || 0.50);
    const validTypes = ["asinSameAs", "asinCategorySameAs", "asinBrandSameAs"];
    if (!validTypes.includes(expressionType))
      return res.status(400).json({ error: "Invalid expressionType" });

    const { rows: [ag] } = await query(
      `SELECT ag.id, ag.amazon_ag_id, ag.campaign_id,
              c.amazon_campaign_id, c.campaign_type,
              c.profile_id AS profile_db_id,
              p.profile_id AS amazon_profile_id,
              p.connection_id, p.marketplace_id
       FROM ad_groups ag
       JOIN campaigns c ON c.id = ag.campaign_id
       JOIN amazon_profiles p ON p.id = c.profile_id
       WHERE ag.id = $1 AND ag.workspace_id = $2`,
      [adGroupId, req.workspaceId]
    );
    if (!ag) return res.status(404).json({ error: "Ad group not found" });

    const expression = [{ type: expressionType, value: expressionValue.trim().toUpperCase() }];
    const fakeId = `tgt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const { rows: [ins] } = await query(
      `INSERT INTO targets
         (workspace_id, profile_id, campaign_id, ad_group_id, amazon_target_id,
          ad_type, expression_type, expression, resolved_expression, state, bid, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'SP','manual',$6,$6,'enabled',$7,NOW(),NOW())
       RETURNING id, expression, expression_type, bid, state`,
      [req.workspaceId, ag.profile_db_id, ag.campaign_id, adGroupId, fakeId,
       JSON.stringify(expression), bidVal]
    );

    // Push to Amazon (non-fatal)
    const amazonExprType = expressionType.replace(/([A-Z])/g, '_$1').toUpperCase();
    try {
      await apiPost({
        connectionId: ag.connection_id,
        profileId: ag.amazon_profile_id?.toString(),
        marketplace: ag.marketplace_id,
        path: "/sp/targets",
        data: { targets: [{
          campaignId:     ag.amazon_campaign_id,
          adGroupId:      ag.amazon_ag_id,
          expressionType: "MANUAL",
          expression:     [{ type: amazonExprType, value: expressionValue.trim().toUpperCase() }],
          state:          "ENABLED",
          bid:            bidVal,
        }]},
        group: "targets",
      });
    } catch (e) {
      logger.warn("Target create write-back failed (non-fatal)", { error: e.message });
    }

    await writeAudit({
      orgId: req.orgId, workspaceId: req.workspaceId,
      actorId: req.user.id, actorName: req.user.name,
      action: "target.added", entityType: "target",
      entityId: ins.id, entityName: `${expressionType}: ${expressionValue.trim()}`,
      afterData: { expression_type: "manual", expression, bid: bidVal },
      source: "ui",
    });

    res.json({ data: { ...ins, resolved_expression: expression } });
  } catch (err) { next(err); }
});

// PATCH /targets/bulk — bulk state/bid update
router.patch("/bulk", async (req, res, next) => {
  try {
    const { updates } = req.body;
    if (!updates?.length) return res.status(400).json({ error: "updates required" });
    let updated = 0;

    for (const { id, bid, state } of updates) {
      const { rows: [tgt] } = await query(
        "SELECT id FROM targets WHERE id = $1 AND workspace_id = $2",
        [id, req.workspaceId]
      );
      if (!tgt) continue;

      const sets = [], vals = [];
      let pi = 1;
      if (bid   !== undefined) { sets.push(`bid   = $${pi++}`); vals.push(parseFloat(bid)); }
      if (state !== undefined) { sets.push(`state = $${pi++}`); vals.push(state); }
      if (!sets.length) continue;
      vals.push(id, req.workspaceId);
      await query(
        `UPDATE targets SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${pi++} AND workspace_id = $${pi}`,
        vals
      );
      updated++;
    }

    res.json({ updated });
  } catch (err) { next(err); }
});

// PATCH /targets/:id — update bid and/or state
router.patch("/:id", async (req, res, next) => {
  try {
    const { state, bid } = req.body;
    const allowed = ["enabled", "paused", "archived"];
    if (state && !allowed.includes(state)) {
      return res.status(400).json({ error: `state must be one of: ${allowed.join(", ")}` });
    }
    if (bid !== undefined && (isNaN(parseFloat(bid)) || parseFloat(bid) < 0.02)) {
      return res.status(400).json({ error: "bid must be >= 0.02" });
    }

    const { rows: [tgt] } = await query(
      `SELECT t.*, c.campaign_type,
              p.profile_id AS amazon_profile_id, p.marketplace_id,
              conn.id AS connection_id
       FROM targets t
       JOIN campaigns c           ON c.id    = t.campaign_id
       JOIN amazon_profiles p     ON p.id    = t.profile_id
       JOIN amazon_connections conn ON conn.id = p.connection_id
       WHERE t.id = $1 AND t.workspace_id = $2`,
      [req.params.id, req.workspaceId]
    );
    if (!tgt) return res.status(404).json({ error: "Target not found" });

    const before = { state: tgt.state, bid: tgt.bid };

    const setClauses = [];
    const vals = [];
    let pi = 1;
    if (state !== undefined) { setClauses.push(`state = $${pi++}`); vals.push(state); }
    if (bid   !== undefined) { setClauses.push(`bid   = $${pi++}`); vals.push(parseFloat(bid)); }
    vals.push(req.params.id);
    if (setClauses.length) {
      await query(
        `UPDATE targets SET ${setClauses.join(", ")}, updated_at = NOW() WHERE id = $${pi}`,
        vals
      );
    }

    const after = {
      state: state !== undefined ? state              : tgt.state,
      bid:   bid   !== undefined ? parseFloat(bid)   : tgt.bid,
    };

    // Amazon write-back (non-fatal)
    const endpoint   = tgt.ad_type === "SD" ? "/sd/targets" : "/sp/targets";
    const tgtPayload = { targetId: tgt.amazon_target_id };
    if (state !== undefined) tgtPayload.state = state.toUpperCase();
    if (bid   !== undefined) tgtPayload.bid   = parseFloat(bid);

    try {
      await put({
        connectionId: tgt.connection_id,
        profileId:    String(tgt.amazon_profile_id),
        marketplace:  tgt.marketplace_id,
        path:         endpoint,
        data:         { targets: [tgtPayload] },
        group:        "default",
      });
      logger.info("Target write-back ok", { id: req.params.id });
    } catch (e) {
      logger.warn("Target write-back failed (non-fatal)", { id: req.params.id, error: e.message });
    }

    await writeAudit({
      orgId:       req.orgId,
      workspaceId: req.workspaceId,
      actorId:     req.user.id,
      actorName:   req.user.name,
      action:      "target.update",
      entityType:  "target",
      entityId:    req.params.id,
      entityName:  String(tgt.amazon_target_id),
      beforeData:  before,
      afterData:   after,
      source:      "ui",
    });

    res.json({ ok: true, before, after });
  } catch (err) { next(err); }
});

module.exports = router;
