const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { writeAudit } = require("./audit");

const router = express.Router();
router.use(requireAuth, requireWorkspace);

// GET /search-terms
router.get("/", async (req, res, next) => {
  try {
    const {
      limit: rawLimit = 100,
      page = 1,
      sortBy = "spend",
      sortDir = "desc",
      search,
      minClicks,
      minSpend,
      hasOrders,
      noOrders,
      dateFrom,
      dateTo,
      metricsDays,
    } = req.query;

    const VALID_LIMITS = [25, 50, 100, 200, 500];
    const limit = VALID_LIMITS.includes(parseInt(rawLimit)) ? parseInt(rawLimit) : 100;
    const offset = (parseInt(page) - 1) * limit;

    const conditions = ["stm.workspace_id = $1"];
    const params = [req.workspaceId];
    let pi = 2;

    // Multi-campaign filter
    const rawCampaignIds = req.query['campaignIds[]'] || req.query.campaignIds;
    const campaignIds = rawCampaignIds
      ? (Array.isArray(rawCampaignIds) ? rawCampaignIds : rawCampaignIds.split(','))
          .filter(id => id && id.trim())
      : null;
    if (campaignIds && campaignIds.length > 0) {
      conditions.push(`stm.campaign_id = ANY($${pi++})`);
      params.push(campaignIds);
    }

    // Date range filter using date_start/date_end columns
    if (dateFrom && dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      conditions.push(`stm.date_start >= $${pi++}::date AND stm.date_end <= $${pi++}::date`);
      params.push(dateFrom, dateTo);
    } else {
      const days = Math.min(Math.max(parseInt(metricsDays) || 30, 1), 365);
      conditions.push(`stm.date_start >= (NOW() - INTERVAL '${days} days')::date`);
    }

    if (search) {
      conditions.push(`stm.query ILIKE $${pi++}`);
      params.push(`%${search}%`);
    }
    if (minClicks) {
      conditions.push(`stm.clicks >= $${pi++}`);
      params.push(parseInt(minClicks));
    }
    if (minSpend) {
      conditions.push(`stm.spend >= $${pi++}`);
      params.push(parseFloat(minSpend));
    }
    if (noOrders === "true") {
      conditions.push(`stm.orders = 0 AND stm.clicks > 0`);
    }
    if (hasOrders === "true") {
      conditions.push(`stm.orders > 0`);
    }

    const allowedSort = { spend: "stm.spend", clicks: "stm.clicks", orders: "stm.orders", impressions: "stm.impressions", query: "stm.query" };
    const orderField = allowedSort[sortBy] || "stm.spend";
    const orderDir = sortDir === "asc" ? "ASC" : "DESC";
    const where = conditions.join(" AND ");

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT stm.*,
           CASE WHEN stm.sales > 0
                THEN ROUND((stm.spend / stm.sales * 100)::numeric, 2)
                ELSE NULL
           END AS acos
         FROM search_term_metrics stm
         WHERE ${where}
         ORDER BY ${orderField} ${orderDir} NULLS LAST
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*) as total FROM search_term_metrics stm WHERE ${where}`,
        params
      ),
    ]);

    res.json({
      data: rows,
      pagination: {
        total: parseInt(countRows[0].total),
        page: parseInt(page),
        limit,
        pages: Math.ceil(parseInt(countRows[0].total) / limit),
      },
    });
  } catch (err) { next(err); }
});

// POST /search-terms/add-keyword — harvest query as new keyword
router.post("/add-keyword", async (req, res, next) => {
  try {
    const { query: searchQuery, campaignId, adGroupId: adGroupIdReq, bid, matchType = "exact" } = req.body;
    if (!searchQuery || !campaignId) {
      return res.status(400).json({ error: "query and campaignId are required" });
    }

    const { rows: campRows } = await query(
      "SELECT profile_id FROM campaigns WHERE id = $1",
      [campaignId]
    );
    const profileId = campRows[0]?.profile_id;
    if (!profileId) return res.status(400).json({ error: "Campaign not found" });

    // Resolve ad_group_id (NOT NULL) — use provided value or fall back to first ad group
    const { rows: agRows } = await query(
      "SELECT id FROM ad_groups WHERE campaign_id = $1 ORDER BY created_at ASC LIMIT 1",
      [campaignId]
    );
    const adGroupId = adGroupIdReq || agRows[0]?.id;
    if (!adGroupId) return res.status(400).json({ error: "No ad group found for this campaign" });

    const { rows: existing } = await query(
      "SELECT id FROM keywords WHERE ad_group_id = $1 AND LOWER(keyword_text) = LOWER($2) AND match_type = $3",
      [adGroupId, searchQuery, matchType]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: "Keyword already exists", keywordId: existing[0].id });
    }

    const { rows: [kw] } = await query(
      `INSERT INTO keywords
         (workspace_id, profile_id, ad_group_id, campaign_id, amazon_keyword_id,
          keyword_text, match_type, state, bid, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'harvest_' || gen_random_uuid(), $5, $6, 'enabled', $7, NOW(), NOW())
       RETURNING id`,
      [req.workspaceId, profileId, adGroupId, campaignId, searchQuery, matchType, parseFloat(bid) || 0.50]
    );

    await writeAudit({
      orgId:       req.orgId,
      workspaceId: req.workspaceId,
      actorId:     req.user.id,
      actorName:   req.user.name,
      action:      "keyword.created",
      entityType:  "keyword",
      entityId:    kw.id,
      entityName:  searchQuery,
      afterData:   { keyword_text: searchQuery, match_type: matchType, source: "search_term_harvest" },
      source:      "ui",
    });

    res.json({ success: true, keywordId: kw.id });
  } catch (err) { next(err); }
});

// POST /search-terms/add-negative — add query as negative keyword
router.post("/add-negative", async (req, res, next) => {
  try {
    const { query: searchQuery, campaignId, adGroupId, matchType = "exact" } = req.body;
    if (!searchQuery || !campaignId) {
      return res.status(400).json({ error: "query and campaignId are required" });
    }

    const { rows: existing } = await query(
      `SELECT id FROM keywords
       WHERE campaign_id = $1 AND LOWER(keyword_text) = LOWER($2) AND match_type = $3 AND state = 'negative'`,
      [campaignId, searchQuery, matchType]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: "Negative keyword already exists" });
    }

    const { rows: campRows } = await query(
      "SELECT profile_id FROM campaigns WHERE id = $1",
      [campaignId]
    );
    const profileId = campRows[0]?.profile_id;
    if (!profileId) return res.status(400).json({ error: "Campaign not found" });

    const { rows: agRows } = await query(
      "SELECT id FROM ad_groups WHERE campaign_id = $1 ORDER BY created_at ASC LIMIT 1",
      [campaignId]
    );
    const resolvedAdGroupId = adGroupId || agRows[0]?.id;
    if (!resolvedAdGroupId) return res.status(400).json({ error: "No ad group found for this campaign" });

    const { rows: [kw] } = await query(
      `INSERT INTO keywords
         (workspace_id, profile_id, campaign_id, ad_group_id, amazon_keyword_id, keyword_text, match_type, state, bid, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'harvest_neg_' || gen_random_uuid(), $5, $6, 'negative', 0, NOW(), NOW())
       RETURNING id`,
      [req.workspaceId, profileId, campaignId, resolvedAdGroupId, searchQuery, matchType]
    );

    await writeAudit({
      orgId:       req.orgId,
      workspaceId: req.workspaceId,
      actorId:     req.user.id,
      actorName:   req.user.name,
      action:      "keyword.negative_added",
      entityType:  "keyword",
      entityId:    kw.id,
      entityName:  searchQuery,
      afterData:   { keyword_text: searchQuery, match_type: matchType, source: "search_term_harvest" },
      source:      "ui",
    });

    res.json({ success: true, keywordId: kw.id });
  } catch (err) { next(err); }
});

module.exports = router;
