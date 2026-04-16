const express = require("express");
const { query, withTransaction } = require("../db/pool");
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { writeAudit } = require("./audit");
const { post: apiPost, patch: apiPatch } = require("../services/amazon/adsClient");
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
    const { state, dailyBudget, biddingStrategy, placements } = req.body;
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
    if (biddingStrategy && !placements) amazonPayload.bidding = { strategy: biddingStrategy };
    if (placements) {
      amazonPayload.bidding = {
        strategy: biddingStrategy || campaign.bidding_strategy || "legacyForSales",
        adjustments: placements.map(p => ({
          predicate:  p.predicate,
          percentage: Math.min(900, Math.max(0, parseInt(p.percentage) || 0)),
        })),
      };
    }

    const endpoint = {
      sponsoredProducts: "/v2/sp/campaigns",
      sponsoredBrands: "/v2/sb/campaigns",
      sponsoredDisplay: "/v2/sd/campaigns",
    }[campaign.campaign_type];

    // Apply to Amazon
    // Placement-only calls are non-fatal; budget/state/strategy changes surface errors to user
    if (endpoint) {
      if (placements && !state && dailyBudget === undefined && !biddingStrategy) {
        // Placement-only update: non-fatal
        apiPatch({
          connectionId: campaign.connection_id,
          profileId: String(campaign.amazon_profile_id),
          marketplace: campaign.marketplace_id,
          path: endpoint,
          data: [amazonPayload],
          group: "campaigns",
        }).catch(e => logger.warn("Placement write-back failed (non-fatal)", { error: e.message }));
      } else {
        await apiPatch({
          connectionId: campaign.connection_id,
          profileId: String(campaign.amazon_profile_id),
          marketplace: campaign.marketplace_id,
          path: endpoint,
          data: [amazonPayload],
          group: "campaigns",
        });
      }
    }

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

// GET /campaigns/:id/placement — return current placement bid adjustments
router.get("/:id/placement", async (req, res, next) => {
  try {
    const { rows: [camp] } = await query(
      `SELECT raw_data, bidding_strategy FROM campaigns WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.workspaceId]
    );
    if (!camp) return res.status(404).json({ error: "Campaign not found" });

    // Amazon SP API v3 stores placement in raw_data.dynamicBidding.placementBidding
    // Amazon SP API v2 format uses raw_data.bidding.adjustments
    // Handle both formats:
    const v3 = camp.raw_data?.dynamicBidding?.placementBidding || [];
    const v2 = camp.raw_data?.bidding?.adjustments || [];

    let top = 0, pp = 0;
    if (v3.length > 0) {
      top = v3.find(a => a.placement === "PLACEMENT_TOP")?.percentage ?? 0;
      pp  = v3.find(a => a.placement === "PLACEMENT_PRODUCT_PAGE")?.percentage ?? 0;
    } else if (v2.length > 0) {
      top = v2.find(a => a.predicate === "placementTop")?.percentage ?? 0;
      pp  = v2.find(a => a.predicate === "placementProductPage")?.percentage ?? 0;
    }

    res.json({ placementTop: top, placementProductPage: pp, strategy: camp.bidding_strategy });
  } catch (err) { next(err); }
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

// POST /campaigns — create a new campaign
router.post("/", async (req, res, next) => {
  try {
    const {
      profileId,
      name,
      campaignType = "sponsoredProducts",
      state = "enabled",
      dailyBudget,
      targetingType = "manual",
      startDate,
      endDate,
      biddingStrategy = "legacyForSales",
    } = req.body;

    if (!profileId || !name?.trim())
      return res.status(400).json({ error: "profileId and name required" });

    const budget = parseFloat(dailyBudget);
    if (isNaN(budget) || budget < 1)
      return res.status(400).json({ error: "dailyBudget must be at least 1" });

    if (!["sponsoredProducts", "sponsoredBrands", "sponsoredDisplay"].includes(campaignType))
      return res.status(400).json({ error: "Invalid campaignType" });

    const { rows: [profile] } = await query(
      `SELECT p.id, p.profile_id AS amazon_profile_id, p.marketplace_id, p.connection_id
       FROM amazon_profiles p
       WHERE p.id = $1 AND p.workspace_id = $2`,
      [profileId, req.workspaceId]
    );
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    const today = new Date().toISOString().slice(0, 10);
    const startFmt = (startDate || today).replace(/-/g, "");

    let amazonCampaignId = `camp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const path = {
      sponsoredProducts: "/sp/campaigns",
      sponsoredBrands:   "/sb/campaigns",
      sponsoredDisplay:  "/sd/campaigns",
    }[campaignType];

    let amazonData;
    if (campaignType === "sponsoredProducts") {
      const camp = {
        name: name.trim(),
        campaignType: "sponsoredProducts",
        state: state.toUpperCase(),
        targetingType: (targetingType || "manual").toUpperCase(),
        startDate: startFmt,
        budget: { budgetType: "DAILY", budget },
      };
      if (endDate) camp.endDate = endDate.replace(/-/g, "");
      amazonData = { campaigns: [camp] };
    } else if (campaignType === "sponsoredBrands") {
      const camp = {
        name: name.trim(),
        campaignType: "sponsoredBrands",
        state: state.toUpperCase(),
        startDate: startFmt,
        budget,
        budgetType: "dailyBudget",
      };
      if (endDate) camp.endDate = endDate.replace(/-/g, "");
      amazonData = { campaigns: [camp] };
    } else {
      const camp = {
        name: name.trim(),
        campaignType: "sponsoredDisplay",
        state: state.toUpperCase(),
        startDate: startFmt,
        budget,
        budgetType: "daily",
      };
      if (endDate) camp.endDate = endDate.replace(/-/g, "");
      amazonData = { campaigns: [camp] };
    }

    try {
      const result = await apiPost({
        connectionId: profile.connection_id,
        profileId:    String(profile.amazon_profile_id),
        marketplace:  profile.marketplace_id,
        path,
        data:         amazonData,
        group:        "campaigns",
      });
      const created = result?.campaigns?.success?.[0];
      if (created?.campaignId) amazonCampaignId = String(created.campaignId);
    } catch (e) {
      logger.warn("Campaign create write-back failed (non-fatal)", { error: e.message });
    }

    const { rows: [ins] } = await query(
      `INSERT INTO campaigns
         (workspace_id, profile_id, amazon_campaign_id, name, campaign_type, state,
          daily_budget, targeting_type, bidding_strategy, start_date, end_date, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
       RETURNING id, name, campaign_type, state, daily_budget, targeting_type, bidding_strategy, start_date, end_date`,
      [
        req.workspaceId, profileId, amazonCampaignId,
        name.trim(), campaignType, state,
        budget, targetingType, biddingStrategy,
        startDate || today,
        endDate || null,
      ]
    );

    await writeAudit({
      orgId:       req.orgId,
      workspaceId: req.workspaceId,
      actorId:     req.user.id,
      actorName:   req.user.name,
      action:      "campaign.created",
      entityType:  "campaign",
      entityId:    ins.id,
      entityName:  name.trim(),
      afterData:   { name: name.trim(), campaignType, dailyBudget: budget, state },
      source:      "ui",
    });

    res.json({ data: ins });
  } catch (err) { next(err); }
});

module.exports = router;
