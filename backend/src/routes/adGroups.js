const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { put, post: apiPost } = require("../services/amazon/adsClient");
const { writeAudit } = require("./audit");
const logger = require("../config/logger");

const router = express.Router();
router.use(requireAuth, requireWorkspace);

// GET /ad-groups — list with metrics
router.get("/", async (req, res, next) => {
  try {
    const {
      campaignId, state, search,
      page = 1, limit: rawLimit = 200,
      sortBy = "spend", sortDir = "desc",
      metricsDays = 30,
    } = req.query;

    const limit     = Math.min(parseInt(rawLimit)   || 200, 1000);
    const offset    = (Math.max(parseInt(page), 1) - 1) * limit;
    const mInterval = Math.min(Math.max(parseInt(metricsDays) || 30, 1), 365);

    const conditions = ["ag.workspace_id = $1"];
    const params = [req.workspaceId];
    let pi = 2;

    if (campaignId) { conditions.push(`ag.campaign_id = $${pi++}`); params.push(campaignId); }
    if (state && state !== "all") { conditions.push(`ag.state = $${pi++}`); params.push(state); }
    if (search) { conditions.push(`ag.name ILIKE $${pi++}`); params.push(`%${search}%`); }

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
        AND entity_type = 'ad_group'
      GROUP BY amazon_id
    ) m ON m.amazon_id = ag.amazon_ag_id`;

    const allowedSort = {
      spend:       "COALESCE(m.cost,0)",
      sales:       "COALESCE(m.sales_14d,0)",
      acos:        "m.acos_14d",
      roas:        "m.roas_14d",
      name:        "ag.name",
      state:       "ag.state",
      clicks:      "COALESCE(m.clicks,0)",
      orders:      "COALESCE(m.orders_14d,0)",
      default_bid: "ag.default_bid",
    };
    const orderField = allowedSort[sortBy] || "COALESCE(m.cost,0)";
    const orderDir   = sortDir === "asc" ? "ASC" : "DESC";

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT
           ag.id, ag.amazon_ag_id, ag.name, ag.state, ag.default_bid,
           ag.campaign_id, ag.created_at,
           c.name           AS campaign_name,
           c.campaign_type,
           c.targeting_type,
           p.profile_id     AS amazon_profile_id,
           p.marketplace_id,
           conn.id          AS connection_id,
           (SELECT COUNT(*) FROM keywords k
            WHERE k.ad_group_id = ag.id AND k.state != 'archived') AS keyword_count,
           (SELECT COUNT(*) FROM targets  t
            WHERE t.ad_group_id = ag.id AND t.state != 'archived') AS target_count,
           COALESCE(m.impressions,0) AS impressions,
           COALESCE(m.clicks,0)     AS clicks,
           COALESCE(m.cost,0)       AS spend,
           COALESCE(m.sales_14d,0)  AS sales,
           COALESCE(m.orders_14d,0) AS orders,
           m.acos_14d AS acos,
           m.roas_14d AS roas,
           m.cpc
         FROM ad_groups ag
         JOIN campaigns c           ON c.id    = ag.campaign_id
         JOIN amazon_profiles p     ON p.id    = ag.profile_id
         JOIN amazon_connections conn ON conn.id = p.connection_id
         ${metricsJoin}
         ${where}
         ORDER BY ${orderField} ${orderDir} NULLS LAST
         LIMIT ${limit} OFFSET $${pi++}`,
        [...params, offset]
      ),
      query(
        `SELECT COUNT(*) AS total
         FROM ad_groups ag
         JOIN campaigns c ON c.id = ag.campaign_id
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

// POST /ad-groups — create a new ad group
router.post("/", async (req, res, next) => {
  try {
    const { campaignId, name, defaultBid = 0.50 } = req.body;
    if (!campaignId || !name?.trim())
      return res.status(400).json({ error: "campaignId and name required" });
    const bidVal = Math.max(0.02, parseFloat(defaultBid) || 0.50);

    const { rows: [camp] } = await query(
      `SELECT c.id, c.amazon_campaign_id, c.campaign_type,
              c.profile_id AS profile_db_id,
              p.profile_id AS amazon_profile_id,
              p.connection_id, p.marketplace_id
       FROM campaigns c
       JOIN amazon_profiles p ON p.id = c.profile_id
       WHERE c.id = $1 AND c.workspace_id = $2`,
      [campaignId, req.workspaceId]
    );
    if (!camp) return res.status(404).json({ error: "Campaign not found" });

    let amazonAgId = `ag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const endpoint = camp.campaign_type === "sponsoredDisplay" ? "/sd/adGroups"
                   : camp.campaign_type === "sponsoredBrands"  ? "/sb/adGroups"
                   : "/sp/adGroups";
    try {
      const result = await apiPost({
        connectionId: camp.connection_id,
        profileId: camp.amazon_profile_id?.toString(),
        marketplace: camp.marketplace_id,
        path: endpoint,
        data: { adGroups: [{
          campaignId:  camp.amazon_campaign_id,
          name:        name.trim(),
          defaultBid:  bidVal,
          state:       "ENABLED",
        }]},
        group: "ad_groups",
      });
      const created = result?.adGroups?.success?.[0];
      if (created?.adGroupId) amazonAgId = String(created.adGroupId);
    } catch (e) {
      logger.warn("Ad group create write-back failed (non-fatal)", { error: e.message });
    }

    const { rows: [ins] } = await query(
      `INSERT INTO ad_groups
         (workspace_id, profile_id, campaign_id, amazon_ag_id, name, state, default_bid, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'enabled',$6,NOW(),NOW())
       RETURNING id, name, state, default_bid, campaign_id`,
      [req.workspaceId, camp.profile_db_id, campaignId, amazonAgId, name.trim(), bidVal]
    );

    await writeAudit({
      orgId: req.orgId, workspaceId: req.workspaceId,
      actorId: req.user.id, actorName: req.user.name,
      action: "ad_group.created", entityType: "ad_group",
      entityId: ins.id, entityName: name.trim(),
      afterData: { name: name.trim(), defaultBid: bidVal, campaignId },
      source: "ui",
    });

    res.json({ data: { ...ins, keyword_count: 0, target_count: 0, spend: 0, sales: 0 } });
  } catch (err) { next(err); }
});

// PATCH /ad-groups/:id — update state and/or defaultBid
router.patch("/:id", async (req, res, next) => {
  try {
    const { state, defaultBid } = req.body;
    const allowed = ["enabled", "paused", "archived"];
    if (state && !allowed.includes(state)) {
      return res.status(400).json({ error: `state must be one of: ${allowed.join(", ")}` });
    }
    if (defaultBid !== undefined && (isNaN(parseFloat(defaultBid)) || parseFloat(defaultBid) < 0.02)) {
      return res.status(400).json({ error: "defaultBid must be >= 0.02" });
    }

    const { rows: [ag] } = await query(
      `SELECT ag.*, c.campaign_type,
              p.profile_id AS amazon_profile_id, p.marketplace_id,
              conn.id AS connection_id
       FROM ad_groups ag
       JOIN campaigns c           ON c.id    = ag.campaign_id
       JOIN amazon_profiles p     ON p.id    = ag.profile_id
       JOIN amazon_connections conn ON conn.id = p.connection_id
       WHERE ag.id = $1 AND ag.workspace_id = $2`,
      [req.params.id, req.workspaceId]
    );
    if (!ag) return res.status(404).json({ error: "Ad group not found" });

    const before = { state: ag.state, defaultBid: ag.default_bid };

    // Update local DB
    const setClauses = [];
    const vals = [];
    let pi = 1;
    if (state      !== undefined) { setClauses.push(`state       = $${pi++}`); vals.push(state); }
    if (defaultBid !== undefined) { setClauses.push(`default_bid = $${pi++}`); vals.push(parseFloat(defaultBid)); }
    vals.push(req.params.id);
    if (setClauses.length) {
      await query(
        `UPDATE ad_groups SET ${setClauses.join(", ")}, updated_at = NOW() WHERE id = $${pi}`,
        vals
      );
    }

    const after = {
      state:      state      !== undefined ? state                   : ag.state,
      defaultBid: defaultBid !== undefined ? parseFloat(defaultBid) : ag.default_bid,
    };

    // Amazon write-back (non-fatal)
    const endpoint  = ag.campaign_type === "sponsoredDisplay" ? "/sd/adGroups" : "/sp/adGroups";
    const agPayload = { adGroupId: ag.amazon_ag_id };
    if (state      !== undefined) agPayload.state      = state.toUpperCase();
    if (defaultBid !== undefined) agPayload.defaultBid = parseFloat(defaultBid);

    try {
      await put({
        connectionId: ag.connection_id,
        profileId:    String(ag.amazon_profile_id),
        marketplace:  ag.marketplace_id,
        path:         endpoint,
        data:         { adGroups: [agPayload] },
        group:        "ad_groups",
      });
      logger.info("Ad group write-back ok", { id: req.params.id });
    } catch (e) {
      logger.warn("Ad group write-back failed (non-fatal)", { id: req.params.id, error: e.message });
    }

    await writeAudit({
      orgId:       req.orgId,
      workspaceId: req.workspaceId,
      actorId:     req.user.id,
      actorName:   req.user.name,
      action:      "ad_group.update",
      entityType:  "ad_group",
      entityId:    req.params.id,
      entityName:  ag.name,
      beforeData:  before,
      afterData:   after,
      source:      "ui",
    });

    res.json({ ok: true, before, after });
  } catch (err) { next(err); }
});

module.exports = router;
