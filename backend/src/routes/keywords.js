const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { writeAudit, updateAuditStatus } = require("./audit");
const { pushKeywordUpdates, loadKeywordContext } = require("../services/amazon/writeback");
const logger = require("../config/logger");

const router = express.Router();
router.use(requireAuth, requireWorkspace);

// GET /keywords — returns { data, pagination: { total, page, limit, pages } }
router.get("/", async (req, res, next) => {
  try {
    const VALID_LIMITS = [25, 50, 100, 200, 500];
    const { adGroupId, state, search, page = 1, sortBy = "keyword_text", sortDir = "asc", dateFrom, dateTo, metricsDays } = req.query;
    const rawLimit = parseInt(req.query.limit);
    const limit = VALID_LIMITS.includes(rawLimit) ? rawLimit : 100;
    const offset = (parseInt(page) - 1) * limit;

    const conditions = ["k.workspace_id = $1"];
    const params = [req.workspaceId];
    let pi = 2;

    // Multi-campaign filter
    const rawCampaignIds = req.query['campaignIds[]'] || req.query.campaignIds;
    const campaignIds = rawCampaignIds
      ? (Array.isArray(rawCampaignIds) ? rawCampaignIds : rawCampaignIds.split(','))
          .filter(id => id && id.trim())
      : null;
    if (campaignIds && campaignIds.length > 0) {
      conditions.push(`k.campaign_id = ANY($${pi++})`);
      params.push(campaignIds);
    }

    // Portfolio filter
    const rawPortfolioIds = req.query['portfolioIds[]'] || req.query.portfolioIds;
    const portfolioIds = rawPortfolioIds
      ? (Array.isArray(rawPortfolioIds) ? rawPortfolioIds : rawPortfolioIds.split(','))
          .filter(id => id && id.trim())
      : null;
    if (portfolioIds && portfolioIds.length > 0) {
      conditions.push(`c.amazon_portfolio_id = ANY($${pi++})`);
      params.push(portfolioIds);
    }

    if (adGroupId)  { conditions.push(`k.ad_group_id = $${pi++}`);      params.push(adGroupId); }
    if (state)      { conditions.push(`k.state = $${pi++}`);            params.push(state); }
    if (search)     { conditions.push(`k.keyword_text ILIKE $${pi++}`); params.push(`%${search}%`); }

    const matchType = req.query.matchType && req.query.matchType !== "all" ? req.query.matchType : null;
    if (matchType) { conditions.push(`k.match_type = $${pi++}`); params.push(matchType.toLowerCase()); }

    const campaignType = req.query.campaignType && req.query.campaignType !== "all" ? req.query.campaignType : null;
    if (campaignType) {
      const typeMap = { SP: "sponsoredProducts", SB: "sponsoredBrands", SD: "sponsoredDisplay" };
      conditions.push(`c.campaign_type = $${pi++}`);
      params.push(typeMap[campaignType] || campaignType);
    }

    const bidMin = parseFloat(req.query.bidMin);
    const bidMax = parseFloat(req.query.bidMax);
    if (!isNaN(bidMin)) { conditions.push(`k.bid >= $${pi++}`); params.push(bidMin); }
    if (!isNaN(bidMax)) { conditions.push(`k.bid <= $${pi++}`); params.push(bidMax); }

    const kwSpendMin  = parseFloat(req.query.spendMin);
    const kwSpendMax  = parseFloat(req.query.spendMax);
    const kwAcosMin   = parseFloat(req.query.acosMin);
    const kwAcosMax   = parseFloat(req.query.acosMax);
    const kwClicksMin = parseInt(req.query.clicksMin);
    const kwOrdersMin = parseInt(req.query.ordersMin);
    if (!isNaN(kwSpendMin))  { conditions.push(`COALESCE(m.cost,0) >= $${pi++}`);       params.push(kwSpendMin); }
    if (!isNaN(kwSpendMax))  { conditions.push(`COALESCE(m.cost,0) <= $${pi++}`);       params.push(kwSpendMax); }
    if (!isNaN(kwAcosMin))   { conditions.push(`m.acos_14d >= $${pi++}`);               params.push(kwAcosMin); }
    if (!isNaN(kwAcosMax))   { conditions.push(`m.acos_14d <= $${pi++}`);               params.push(kwAcosMax); }
    if (!isNaN(kwClicksMin)) { conditions.push(`COALESCE(m.clicks,0) >= $${pi++}`);     params.push(kwClicksMin); }
    if (!isNaN(kwOrdersMin)) { conditions.push(`COALESCE(m.orders_14d,0) >= $${pi++}`); params.push(kwOrdersMin); }
    if (req.query.noSales === "true")               { conditions.push(`COALESCE(m.orders_14d,0) = 0`); }
    if (req.query.hasClicks === "true")             { conditions.push(`COALESCE(m.clicks,0) > 0`); }
    if (req.query.excludePaused === "true")         { conditions.push(`k.state != 'paused'`); }
    if (req.query.excludeDisabledCampaigns === "true") { conditions.push(`c.state = 'enabled'`); }
    if (req.query.campaignState && req.query.campaignState !== "all") {
      const VALID_CAMP_STATES = ["enabled", "paused", "archived"];
      if (VALID_CAMP_STATES.includes(req.query.campaignState)) {
        conditions.push(`c.state = $${pi++}`);
        params.push(req.query.campaignState);
      }
    }

    const where = "WHERE " + conditions.join(" AND ");

    const allowedSortKw = {
      keyword_text: "k.keyword_text",
      match_type:   "k.match_type",
      state:        "k.state",
      bid:          "k.bid",
      campaign:     "c.name",
      clicks:       "COALESCE(m.clicks,0)",
      spend:        "COALESCE(m.cost,0)",
      acos:         "m.acos_14d",
      roas:         "m.roas_14d",
      orders:       "COALESCE(m.orders_14d,0)",
      cpc:          "m.cpc",
    };
    const orderField = allowedSortKw[sortBy] || "k.keyword_text";
    const orderDir   = sortDir === "asc" ? "ASC" : "DESC";

    // Date range for metrics — dateFrom/dateTo take priority over metricsDays
    let dateCondition;
    if (dateFrom && dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      dateCondition = `AND date >= $${pi++}::date AND date <= $${pi++}::date`;
      params.push(dateFrom, dateTo);
    } else {
      const days = Math.min(Math.max(parseInt(metricsDays) || 30, 1), 365);
      dateCondition = `AND date >= NOW() - INTERVAL '${days} days'`;
    }

    const metricsJoin = `LEFT JOIN (
        SELECT amazon_id,
          SUM(clicks) as clicks,
          SUM(cost) as cost,
          SUM(sales_14d) as sales_14d,
          SUM(orders_14d) as orders_14d,
          CASE WHEN SUM(sales_14d)>0 THEN SUM(cost)/SUM(sales_14d)*100 END as acos_14d,
          CASE WHEN SUM(cost)>0 THEN SUM(sales_14d)/SUM(cost) END as roas_14d,
          CASE WHEN SUM(clicks)>0 THEN SUM(cost)/SUM(clicks) END as cpc
        FROM fact_metrics_daily
        WHERE workspace_id = $1 AND entity_type = 'keyword'
          ${dateCondition}
        GROUP BY amazon_id
      ) m ON m.amazon_id = k.amazon_keyword_id`;

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT k.*,
           c.name as campaign_name, c.campaign_type, ag.name as ad_group_name,
           COALESCE(m.clicks,0) as clicks,
           COALESCE(m.cost,0) as spend,
           COALESCE(m.sales_14d,0) as sales,
           COALESCE(m.orders_14d,0) as orders,
           m.acos_14d as acos, m.roas_14d as roas, m.cpc
         FROM keywords k
         JOIN campaigns c ON c.id = k.campaign_id
         JOIN ad_groups ag ON ag.id = k.ad_group_id
         ${metricsJoin}
         ${where}
         ORDER BY ${orderField} ${orderDir} NULLS LAST
         LIMIT ${parseInt(limit)} OFFSET $${pi}`,
        [...params, offset]
      ),
      query(
        `SELECT COUNT(*) as total
         FROM keywords k
         JOIN campaigns c ON c.id = k.campaign_id
         JOIN ad_groups ag ON ag.id = k.ad_group_id
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

// PATCH /keywords/bulk — bulk bid/state update
router.patch("/bulk", async (req, res, next) => {
  try {
    const { updates } = req.body;
    if (!updates?.length) return res.status(400).json({ error: "updates required" });
    let updated = 0;
    const updatedIds = [];
    const auditIds = [];
    for (const { id, bid, state } of updates) {
      const { rows: [kw] } = await query(
        "SELECT id, keyword_text, bid, state FROM keywords WHERE id = $1 AND workspace_id = $2",
        [id, req.workspaceId]
      );
      if (!kw) continue;

      const sets = [], vals = [];
      let pi = 1;
      if (bid   !== undefined) { sets.push(`bid = $${pi++}`);   vals.push(bid); }
      if (state !== undefined) { sets.push(`state = $${pi++}`); vals.push(state); }
      if (!sets.length) continue;
      vals.push(id, req.workspaceId);
      await query(
        `UPDATE keywords SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${pi++} AND workspace_id = $${pi}`,
        vals
      );

      const beforeData = {};
      const afterData  = {};
      if (bid   !== undefined) { beforeData.bid   = parseFloat(kw.bid);   afterData.bid   = parseFloat(bid); }
      if (state !== undefined) { beforeData.state = kw.state;             afterData.state = state; }

      const auditId = await writeAudit({
        orgId:       req.orgId,
        workspaceId: req.workspaceId,
        actorId:     req.user.id,
        actorName:   req.user.name,
        action:      bid !== undefined ? "keyword.bid_change" : "keyword.state_change",
        entityType:  "keyword",
        entityId:    kw.id,
        entityName:  kw.keyword_text,
        beforeData,
        afterData,
        source: "ui",
        amazonStatus: "pending",
      });
      updated++;
      updatedIds.push(id);
      auditIds.push(auditId);
    }

    // Amazon write-back (non-fatal)
    if (updatedIds.length > 0) {
      const ctxRows = await loadKeywordContext(req.workspaceId, updatedIds);
      const writebackUpdates = ctxRows.map(r => {
        const upd = updates.find(u => u.id === r.id);
        return {
          amazonKeywordId: r.amazon_keyword_id,
          campaignType:    r.campaign_type,
          connectionId:    r.connection_id,
          profileId:       r.amazon_profile_id,
          marketplaceId:   r.marketplace_id,
          ...(upd?.bid   !== undefined ? { bid:   upd.bid }   : {}),
          ...(upd?.state !== undefined ? { state: upd.state } : {}),
        };
      });
      pushKeywordUpdates(writebackUpdates)
        .then(r => Promise.all(auditIds.map(id => updateAuditStatus(id, r.ok ? "success" : "error", r.error))))
        .catch(() => {});
    }

    res.json({ updated });
  } catch (err) { next(err); }
});

// PATCH /keywords/:id — single bid/state update
router.patch("/:id", async (req, res, next) => {
  try {
    const { bid, state } = req.body;
    const sets = [], vals = [];
    let pi = 1;
    if (bid   !== undefined) { sets.push(`bid = $${pi++}`);   vals.push(bid); }
    if (state !== undefined) { sets.push(`state = $${pi++}`); vals.push(state); }
    if (!sets.length) return res.status(400).json({ error: "bid or state required" });
    vals.push(req.params.id, req.workspaceId);
    const { rows: [kw] } = await query(
      `UPDATE keywords SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${pi++} AND workspace_id = $${pi} RETURNING *`,
      vals
    );
    if (!kw) return res.status(404).json({ error: "Keyword not found" });

    // Amazon write-back (non-fatal, fire-and-forget)
    loadKeywordContext(req.workspaceId, [req.params.id]).then(ctxRows => {
      if (!ctxRows.length) return;
      const r = ctxRows[0];
      const upd = {
        amazonKeywordId: r.amazon_keyword_id,
        campaignType:    r.campaign_type,
        connectionId:    r.connection_id,
        profileId:       r.amazon_profile_id,
        marketplaceId:   r.marketplace_id,
        ...(bid   !== undefined ? { bid }   : {}),
        ...(state !== undefined ? { state } : {}),
      };
      return pushKeywordUpdates([upd]);
    }).catch(e => logger.warn("single keyword write-back error", { error: e.message }));

    res.json(kw);
  } catch (err) { next(err); }
});

module.exports = router;
