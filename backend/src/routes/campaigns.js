const express = require("express");
const { query, withTransaction } = require("../db/pool");
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { writeAudit } = require("./audit");
const { post, patch: apiPatch } = require("../services/amazon/adsClient");
const logger = require("../config/logger");

const router = express.Router();
router.use(requireAuth, requireWorkspace);

// GET /campaigns
router.get("/", async (req, res, next) => {
  try {
    const VALID_LIMITS = [25, 50, 100, 200];
    const rawLimit = parseInt(req.query.limit);
    const { sortBy = "spend", sortDir = "desc", page = 1 } = req.query;
    const limit = VALID_LIMITS.includes(rawLimit) ? rawLimit : 100;

    const status = req.query.status && req.query.status !== "undefined" && req.query.status !== "all"
      ? req.query.status : null;
    const type   = req.query.type   && req.query.type   !== "undefined" && req.query.type   !== "all"
      ? req.query.type : null;
    const search = req.query.search && req.query.search !== "undefined"
      ? req.query.search.trim() : null;
    const strategy = req.query.strategy && req.query.strategy !== "all" ? req.query.strategy : null;

    const metricsInterval = Math.min(Math.max(parseInt(req.query.metricsDays) || 30, 1), 365);

    const offset = (parseInt(page) - 1) * limit;
    const conditions = ["c.workspace_id = $1"];
    const params = [req.workspaceId];
    let pi = 2;

    if (status)   { conditions.push(`c.state = $${pi++}`);          params.push(status); }
    if (type)     { conditions.push(`c.campaign_type = $${pi++}`);   params.push(type === "SP" ? "sponsoredProducts" : type === "SB" ? "sponsoredBrands" : "sponsoredDisplay"); }
    if (search)   { conditions.push(`c.name ILIKE $${pi++}`);        params.push(`%${search}%`); }
    if (strategy) { conditions.push(`c.bidding_strategy = $${pi++}`); params.push(strategy); }

    const budgetMin = parseFloat(req.query.budgetMin);
    const budgetMax = parseFloat(req.query.budgetMax);
    if (!isNaN(budgetMin)) { conditions.push(`c.daily_budget >= $${pi++}`); params.push(budgetMin); }
    if (!isNaN(budgetMax)) { conditions.push(`c.daily_budget <= $${pi++}`); params.push(budgetMax); }

    const spendMin  = parseFloat(req.query.spendMin);
    const spendMax  = parseFloat(req.query.spendMax);
    const acosMin   = parseFloat(req.query.acosMin);
    const acosMax   = parseFloat(req.query.acosMax);
    const roasMin   = parseFloat(req.query.roasMin);
    const roasMax   = parseFloat(req.query.roasMax);
    const ordersMin = parseInt(req.query.ordersMin);
    const clicksMin = parseInt(req.query.clicksMin);
    if (!isNaN(spendMin))  { conditions.push(`COALESCE(m.cost,0) >= $${pi++}`);      params.push(spendMin); }
    if (!isNaN(spendMax))  { conditions.push(`COALESCE(m.cost,0) <= $${pi++}`);      params.push(spendMax); }
    if (!isNaN(acosMin))   { conditions.push(`m.acos_14d >= $${pi++}`);              params.push(acosMin); }
    if (!isNaN(acosMax))   { conditions.push(`m.acos_14d <= $${pi++}`);              params.push(acosMax); }
    if (!isNaN(roasMin))   { conditions.push(`m.roas_14d >= $${pi++}`);              params.push(roasMin); }
    if (!isNaN(roasMax))   { conditions.push(`m.roas_14d <= $${pi++}`);              params.push(roasMax); }
    if (!isNaN(ordersMin)) { conditions.push(`COALESCE(m.orders_14d,0) >= $${pi++}`); params.push(ordersMin); }
    if (!isNaN(clicksMin)) { conditions.push(`COALESCE(m.clicks,0) >= $${pi++}`);    params.push(clicksMin); }
    if (req.query.noSales === "true")    { conditions.push(`COALESCE(m.orders_14d,0) = 0`); }
    if (req.query.hasMetrics === "true") { conditions.push(`COALESCE(m.clicks,0) > 0`); }

    const where = "WHERE " + conditions.join(" AND ");

    const allowedSort = {
      spend:       "COALESCE(m.cost,0)",
      sales:       "COALESCE(m.sales_14d,0)",
      acos:        "m.acos_14d",
      roas:        "m.roas_14d",
      name:        "c.name",
      budget:      "c.daily_budget",
      state:       "c.state",
      clicks:      "COALESCE(m.clicks,0)",
      impressions: "COALESCE(m.impressions,0)",
      orders:      "COALESCE(m.orders_14d,0)",
      cpc:         "m.cpc",
      ctr:         "m.ctr",
    };
    const orderField = allowedSort[sortBy] || "COALESCE(m.cost,0)";
    const orderDir   = sortDir === "asc" ? "ASC" : "DESC";

    const metricsJoin = `LEFT JOIN (
        SELECT amazon_id,
          SUM(impressions) as impressions,
          SUM(clicks) as clicks,
          SUM(cost) as cost,
          SUM(sales_14d) as sales_14d,
          SUM(orders_14d) as orders_14d,
          CASE WHEN SUM(impressions)>0 THEN SUM(clicks)::numeric/SUM(impressions) END as ctr,
          CASE WHEN SUM(clicks)>0 THEN SUM(cost)/SUM(clicks) END as cpc,
          CASE WHEN SUM(sales_14d)>0 THEN SUM(cost)/SUM(sales_14d)*100 END as acos_14d,
          CASE WHEN SUM(cost)>0 THEN SUM(sales_14d)/SUM(cost) END as roas_14d
        FROM fact_metrics_daily
        WHERE workspace_id = $1 AND date >= NOW() - INTERVAL '${metricsInterval} days' AND entity_type = 'campaign'
        GROUP BY amazon_id
      ) m ON m.amazon_id = c.amazon_campaign_id`;

    const { rows } = await query(
      `SELECT
         c.id, c.amazon_campaign_id, c.name, c.campaign_type, c.state,
         c.daily_budget, c.start_date, c.end_date, c.bidding_strategy, c.synced_at,
         p.marketplace, p.country_code, p.currency_code,
         COALESCE(m.impressions,0) as impressions,
         COALESCE(m.clicks,0) as clicks,
         COALESCE(m.cost,0) as spend,
         COALESCE(m.sales_14d,0) as sales,
         COALESCE(m.orders_14d,0) as orders,
         m.ctr, m.cpc, m.acos_14d as acos, m.roas_14d as roas
       FROM campaigns c
       JOIN amazon_profiles p ON p.id = c.profile_id
       ${metricsJoin}
       ${where}
       ORDER BY ${orderField} ${orderDir} NULLS LAST
       LIMIT $${pi++} OFFSET $${pi++}`,
      [...params, limit, offset]
    );

    const { rows: countRows } = await query(
      `SELECT count(*) as total
       FROM campaigns c
       JOIN amazon_profiles p ON p.id = c.profile_id
       ${metricsJoin}
       ${where}`,
      params
    );

    const total = parseInt(countRows[0].total);
    res.json({
      data: rows,
      pagination: { total, page: parseInt(page), limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /campaigns/:id
router.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.*, p.marketplace, p.country_code, p.currency_code, p.profile_id as amazon_profile_id,
              conn.id as connection_id
       FROM campaigns c
       JOIN amazon_profiles p ON p.id = c.profile_id
       JOIN amazon_connections conn ON conn.id = p.connection_id
       WHERE c.id = $1 AND c.workspace_id = $2`,
      [req.params.id, req.workspaceId]
    );
    if (!rows.length) return res.status(404).json({ error: "Campaign not found" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /campaigns/:id — update status, budget, bidding strategy
router.patch("/:id", async (req, res, next) => {
  try {
    const { state, dailyBudget, biddingStrategy } = req.body;
    const allowed = ["enabled", "paused", "archived"];
    if (state && !allowed.includes(state)) {
      return res.status(400).json({ error: `state must be one of: ${allowed.join(", ")}` });
    }

    const { rows: [campaign] } = await query(
      `SELECT c.*, p.profile_id as amazon_profile_id, p.marketplace_id, conn.id as connection_id
       FROM campaigns c
       JOIN amazon_profiles p ON p.id = c.profile_id
       JOIN amazon_connections conn ON conn.id = p.connection_id
       WHERE c.id = $1 AND c.workspace_id = $2`,
      [req.params.id, req.workspaceId]
    );
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const before = { state: campaign.state, dailyBudget: campaign.daily_budget };

    // Build Amazon API payload
    const amazonPayload = { campaignId: campaign.amazon_campaign_id };
    if (state) amazonPayload.state = state;
    if (dailyBudget !== undefined) amazonPayload.dailyBudget = parseFloat(dailyBudget);
    if (biddingStrategy) amazonPayload.bidding = { strategy: biddingStrategy };

    const endpoint = {
      sponsoredProducts: "/v2/sp/campaigns",
      sponsoredBrands: "/v2/sb/campaigns",
      sponsoredDisplay: "/v2/sd/campaigns",
    }[campaign.campaign_type];

    // Apply to Amazon
    await apiPatch({
      connectionId: campaign.connection_id,
      profileId: String(campaign.amazon_profile_id),
      marketplace: campaign.marketplace_id,
      path: endpoint,
      data: [amazonPayload],
      group: "campaigns",
    });

    // Update our DB
    const updates = [];
    const vals = [];
    let pi = 1;
    if (state) { updates.push(`state = $${pi++}`); vals.push(state); }
    if (dailyBudget !== undefined) { updates.push(`daily_budget = $${pi++}`); vals.push(dailyBudget); }
    vals.push(req.params.id);

    if (updates.length) {
      await query(`UPDATE campaigns SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${pi}`, vals);
    }

    const after = { state: state || campaign.state, dailyBudget: dailyBudget !== undefined ? dailyBudget : campaign.daily_budget };

    // Audit
    await writeAudit({
      orgId: req.orgId,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      actorName: req.user.name,
      action: "campaign.update",
      entityType: "campaign",
      entityId: req.params.id,
      entityName: campaign.name,
      beforeData: before,
      afterData: after,
      source: "ui",
    });

    res.json({ message: "Campaign updated", before, after });
  } catch (err) {
    next(err);
  }
});

// GET /campaigns/:id/metrics
router.get("/:id/metrics", async (req, res, next) => {
  try {
    const { startDate, endDate, granularity = "day" } = req.query;

    const { rows: [campaign] } = await query(
      "SELECT amazon_campaign_id FROM campaigns WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const { rows } = await query(
      `SELECT date, impressions, clicks, cost,
              sales_14d as sales, orders_14d as orders, ctr, cpc, acos_14d as acos, roas_14d as roas
       FROM fact_metrics_daily
       WHERE workspace_id = $1 AND amazon_id = $2 AND entity_type = 'campaign'
         AND date BETWEEN $3 AND $4
       ORDER BY date`,
      [req.workspaceId, campaign.amazon_campaign_id, startDate || "2020-01-01", endDate || "2099-12-31"]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
