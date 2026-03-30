const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { writeAudit } = require("./audit");
const { queueMetricsBackfill } = require("../jobs/workers");

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
      campaignType,   // SP | SB | SD
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

    // Campaign type filter — join campaigns table
    const VALID_CAMPAIGN_TYPES = ["SP", "SB", "SD", "sponsoredProducts", "sponsoredBrands", "sponsoredDisplay"];
    if (campaignType && VALID_CAMPAIGN_TYPES.includes(campaignType)) {
      // Map short codes to full names stored in campaigns table
      const typeMap = { SP: "sponsoredProducts", SB: "sponsoredBrands", SD: "sponsoredDisplay" };
      const dbType = typeMap[campaignType] || campaignType;
      conditions.push(
        `stm.campaign_id IN (SELECT id FROM campaigns WHERE workspace_id = $1 AND campaign_type = $${pi++})`
      );
      params.push(dbType);
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

// GET /search-terms/campaigns — returns campaigns + ad groups for the harvest modal picker
router.get("/campaigns", async (req, res, next) => {
  try {
    const { campaignType } = req.query;
    const typeMap = { SP: "sponsoredProducts", SB: "sponsoredBrands", SD: "sponsoredDisplay" };
    const conditions = ["c.workspace_id = $1", "c.state != 'archived'"];
    const params = [req.workspaceId];
    let pi = 2;

    if (campaignType && typeMap[campaignType]) {
      conditions.push(`c.campaign_type = $${pi++}`);
      params.push(typeMap[campaignType]);
    }

    const { rows: campaigns } = await query(
      `SELECT c.id, c.name, c.campaign_type,
              json_agg(json_build_object('id', ag.id, 'name', ag.name) ORDER BY ag.name) FILTER (WHERE ag.id IS NOT NULL) AS ad_groups
       FROM campaigns c
       LEFT JOIN ad_groups ag ON ag.campaign_id = c.id AND ag.workspace_id = c.workspace_id
       WHERE ${conditions.join(" AND ")}
       GROUP BY c.id, c.name, c.campaign_type
       ORDER BY c.name
       LIMIT 500`,
      params
    );

    res.json(campaigns);
  } catch (err) { next(err); }
});

// POST /search-terms/sync — trigger search term report refresh for the last 30 days
router.post("/sync", async (req, res, next) => {
  try {
    const today = new Date();
    const dateTo = new Date(today); dateTo.setDate(today.getDate() - 1);
    const dateFrom = new Date(today); dateFrom.setDate(today.getDate() - 30);
    const fmt = d => d.toISOString().split("T")[0];

    await queueMetricsBackfill(req.workspaceId, fmt(dateFrom), fmt(dateTo));

    res.json({ success: true, dateFrom: fmt(dateFrom), dateTo: fmt(dateTo),
      message: "Search term sync queued. Data will appear in a few minutes." });
  } catch (err) { next(err); }
});

// POST /search-terms/add-keyword
// Supports single campaign OR bulk (campaignIds array for account-level add)
router.post("/add-keyword", async (req, res, next) => {
  try {
    const { query: searchQuery, campaignId, campaignIds, adGroupId: adGroupIdReq, bid, matchType = "exact" } = req.body;
    if (!searchQuery) return res.status(400).json({ error: "query is required" });

    // Resolve the list of target campaign IDs
    let targets = [];
    if (campaignIds && Array.isArray(campaignIds) && campaignIds.length > 0) {
      // Account-level or multi-campaign
      targets = campaignIds.map(id => ({ campaignId: id, adGroupId: null }));
    } else if (campaignId) {
      targets = [{ campaignId, adGroupId: adGroupIdReq || null }];
    } else {
      return res.status(400).json({ error: "campaignId or campaignIds is required" });
    }

    const results = [];
    for (const target of targets) {
      const { rows: campRows } = await query(
        "SELECT profile_id FROM campaigns WHERE id = $1 AND workspace_id = $2",
        [target.campaignId, req.workspaceId]
      );
      const profileId = campRows[0]?.profile_id;
      if (!profileId) { results.push({ campaignId: target.campaignId, error: "Campaign not found" }); continue; }

      const { rows: agRows } = await query(
        "SELECT id FROM ad_groups WHERE campaign_id = $1 ORDER BY created_at ASC LIMIT 1",
        [target.campaignId]
      );
      const adGroupId = target.adGroupId || agRows[0]?.id;
      if (!adGroupId) { results.push({ campaignId: target.campaignId, error: "No ad group found" }); continue; }

      const { rows: existing } = await query(
        "SELECT id FROM keywords WHERE ad_group_id = $1 AND LOWER(keyword_text) = LOWER($2) AND match_type = $3",
        [adGroupId, searchQuery, matchType]
      );
      if (existing.length > 0) {
        results.push({ campaignId: target.campaignId, skipped: true, keywordId: existing[0].id, reason: "already_exists" });
        continue;
      }

      const { rows: [kw] } = await query(
        `INSERT INTO keywords
           (workspace_id, profile_id, ad_group_id, campaign_id, amazon_keyword_id,
            keyword_text, match_type, state, bid, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'harvest_' || gen_random_uuid(), $5, $6, 'enabled', $7, NOW(), NOW())
         RETURNING id`,
        [req.workspaceId, profileId, adGroupId, target.campaignId, searchQuery, matchType, parseFloat(bid) || 0.50]
      );

      await writeAudit({
        orgId: req.orgId, workspaceId: req.workspaceId,
        actorId: req.user.id, actorName: req.user.name,
        action: "keyword.created", entityType: "keyword", entityId: kw.id, entityName: searchQuery,
        afterData: { keyword_text: searchQuery, match_type: matchType, source: "search_term_harvest" },
        source: "ui",
      });
      results.push({ campaignId: target.campaignId, success: true, keywordId: kw.id });
    }

    const added = results.filter(r => r.success).length;
    const skipped = results.filter(r => r.skipped).length;
    res.json({ success: added > 0 || skipped > 0, added, skipped, results,
      ...(targets.length === 1 ? { keywordId: results[0]?.keywordId } : {}) });
  } catch (err) { next(err); }
});

// POST /search-terms/add-negative
// Supports single campaign OR bulk (campaignIds array for account-level add)
router.post("/add-negative", async (req, res, next) => {
  try {
    const { query: searchQuery, campaignId, campaignIds, adGroupId, matchType = "exact", level = "campaign" } = req.body;
    if (!searchQuery) return res.status(400).json({ error: "query is required" });

    let targets = [];
    if (campaignIds && Array.isArray(campaignIds) && campaignIds.length > 0) {
      targets = campaignIds.map(id => ({ campaignId: id, adGroupId: null }));
    } else if (campaignId) {
      targets = [{ campaignId, adGroupId: adGroupId || null }];
    } else {
      return res.status(400).json({ error: "campaignId or campaignIds is required" });
    }

    const results = [];
    for (const target of targets) {
      const { rows: campRows } = await query(
        "SELECT profile_id FROM campaigns WHERE id = $1 AND workspace_id = $2",
        [target.campaignId, req.workspaceId]
      );
      const profileId = campRows[0]?.profile_id;
      if (!profileId) { results.push({ campaignId: target.campaignId, error: "Campaign not found" }); continue; }

      const { rows: agRows } = await query(
        "SELECT id FROM ad_groups WHERE campaign_id = $1 ORDER BY created_at ASC LIMIT 1",
        [target.campaignId]
      );
      const resolvedAdGroupId = target.adGroupId || agRows[0]?.id;
      if (!resolvedAdGroupId) { results.push({ campaignId: target.campaignId, error: "No ad group" }); continue; }

      const { rows: existing } = await query(
        `SELECT id FROM keywords
         WHERE campaign_id = $1 AND LOWER(keyword_text) = LOWER($2) AND match_type = $3 AND state = 'negative'`,
        [target.campaignId, searchQuery, matchType]
      );
      if (existing.length > 0) {
        results.push({ campaignId: target.campaignId, skipped: true, reason: "already_exists" });
        continue;
      }

      const { rows: [kw] } = await query(
        `INSERT INTO keywords
           (workspace_id, profile_id, campaign_id, ad_group_id, amazon_keyword_id,
            keyword_text, match_type, state, bid, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'harvest_neg_' || gen_random_uuid(), $5, $6, 'negative', 0, NOW(), NOW())
         RETURNING id`,
        [req.workspaceId, profileId, target.campaignId, resolvedAdGroupId, searchQuery, matchType]
      );

      await writeAudit({
        orgId: req.orgId, workspaceId: req.workspaceId,
        actorId: req.user.id, actorName: req.user.name,
        action: "keyword.negative_added", entityType: "keyword", entityId: kw.id, entityName: searchQuery,
        afterData: { keyword_text: searchQuery, match_type: matchType, source: "search_term_harvest" },
        source: "ui",
      });
      results.push({ campaignId: target.campaignId, success: true, keywordId: kw.id });
    }

    const added = results.filter(r => r.success).length;
    const skipped = results.filter(r => r.skipped).length;
    res.json({ success: added > 0 || skipped > 0, added, skipped, results });
  } catch (err) { next(err); }
});

module.exports = router;
