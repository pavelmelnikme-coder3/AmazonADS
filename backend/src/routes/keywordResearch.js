/**
 * Keyword Research Routes
 *
 * POST /keyword-research/discover       — discover keywords from all sources
 * POST /keyword-research/add-to-adgroup — bulk-add selected keywords to an ad group
 */

const express = require("express");
const router  = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const logger  = require("../config/logger");
const { getAmazonKeywordRecommendations } = require("../services/amazon/keywordRecommendations");
const { getKeywordsByAsin, getKeywordsByKeyword, isConfigured: jsConfigured } = require("../services/junglescout/client");
const { generateSeedKeywords, scoreAndFilterKeywords } = require("../services/ai/keywordResearch");
const { pushNewKeywords } = require("../services/amazon/writeback");
const { writeAudit } = require("./audit");

router.use(requireAuth, requireWorkspace);

// ── POST /keyword-research/discover ──────────────────────────────────────────
router.post("/discover", async (req, res, next) => {
  try {
    const {
      asins,           // string[] — ASINs to research (optional)
      asin,            // string — single ASIN shorthand
      profileId,       // local DB profile UUID (required)
      adGroupId,       // local DB ad group UUID (optional — improves Amazon recommendations)
      productTitle,    // product title for AI (optional — auto-fetched if ASIN known)
      locale = "en",   // target language for AI
      sources = ["amazon", "ai"], // which sources to use
    } = req.body;

    const allAsins = asins?.length ? asins
      : asin ? [asin.trim().toUpperCase()]
      : [];

    if (!profileId) return res.status(400).json({ error: "profileId required" });
    if (!allAsins.length && !productTitle) {
      return res.status(400).json({ error: "asins or productTitle required" });
    }

    // Load profile (connection, marketplace)
    const { rows: [profile] } = await query(
      `SELECT p.connection_id, p.profile_id AS amazon_profile_id, p.marketplace_id
       FROM amazon_profiles p
       WHERE p.id = $1 AND p.workspace_id = $2`,
      [profileId, req.workspaceId]
    );
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    // Load ad group + campaign Amazon IDs if provided
    let agContext = null;
    if (adGroupId) {
      const { rows: [ag] } = await query(
        `SELECT ag.amazon_ag_id, c.amazon_campaign_id
         FROM ad_groups ag JOIN campaigns c ON c.id = ag.campaign_id
         WHERE ag.id = $1 AND ag.workspace_id = $2`,
        [adGroupId, req.workspaceId]
      );
      agContext = ag || null;
    }

    // Auto-fetch product title from DB if not provided
    let resolvedTitle = productTitle;
    if (!resolvedTitle && allAsins.length) {
      const { rows: [prod] } = await query(
        `SELECT title FROM products WHERE asin = $1 AND workspace_id = $2 LIMIT 1`,
        [allAsins[0], req.workspaceId]
      );
      resolvedTitle = prod?.title || null;
    }

    const kwMap = new Map(); // keyword_text.lower → keyword object (dedup)

    function merge(kwList) {
      for (const kw of kwList) {
        const key = (kw.keyword_text || "").trim().toLowerCase();
        if (!key) continue;
        if (!kwMap.has(key)) {
          kwMap.set(key, { ...kw, keyword_text: kw.keyword_text.trim() });
        } else {
          // Merge: keep higher relevance_score, add sources
          const existing = kwMap.get(key);
          if ((kw.relevance_score || 0) > (existing.relevance_score || 0)) {
            kwMap.set(key, { ...existing, ...kw, keyword_text: existing.keyword_text });
          }
          // Merge suggested match types
          const merged = new Set([
            ...(existing.suggested_match_types || []),
            ...(kw.suggested_match_types || []),
          ]);
          kwMap.get(key).suggested_match_types = [...merged];
          // Track all sources
          const existingSrc = existing.source || "";
          if (!existingSrc.includes(kw.source || "")) {
            kwMap.get(key).source = existingSrc
              ? `${existingSrc}+${kw.source}`
              : kw.source;
          }
        }
      }
    }

    const sourcesUsed = [];

    // ── 1. Amazon Ads API keyword recommendations ─────────────────────────────
    if (sources.includes("amazon")) {
      const amazonKws = await getAmazonKeywordRecommendations({
        connectionId:    profile.connection_id,
        profileId:       profile.amazon_profile_id?.toString(),
        marketplaceId:   profile.marketplace_id,
        asins:           allAsins,
        amazonAdGroupId:  agContext?.amazon_ag_id || null,
        amazonCampaignId: agContext?.amazon_campaign_id || null,
      });
      merge(amazonKws);
      if (amazonKws.length) sourcesUsed.push("amazon_ads");
      logger.info("Keyword research: Amazon source", { count: amazonKws.length });
    }

    // ── 2. Jungle Scout — ASIN reverse lookup ────────────────────────────────
    if (sources.includes("jungle_scout") && allAsins.length) {
      const jsKws = await getKeywordsByAsin(allAsins, profile.marketplace_id);
      merge(jsKws);
      if (jsKws.length) sourcesUsed.push("jungle_scout");
      logger.info("Keyword research: Jungle Scout ASIN source", { count: jsKws.length });
    }

    // ── 3. Claude AI — seed keyword generation ───────────────────────────────
    if (sources.includes("ai") && resolvedTitle) {
      const aiKws = await generateSeedKeywords({
        productTitle:       resolvedTitle,
        marketplace:        profile.marketplace_id,
        locale,
      });
      merge(aiKws);
      if (aiKws.length) sourcesUsed.push("ai_generated");
      logger.info("Keyword research: AI source", { count: aiKws.length });
    }

    // ── 4. Jungle Scout — expand top AI seeds ────────────────────────────────
    if (sources.includes("jungle_scout") && sources.includes("ai") && jsConfigured()) {
      const topSeeds = [...kwMap.values()]
        .filter(k => k.source?.includes("ai_generated") && (k.relevance_score || 0) >= 80)
        .slice(0, 3);

      for (const seed of topSeeds) {
        const expanded = await getKeywordsByKeyword(seed.keyword_text, profile.marketplace_id);
        merge(expanded);
      }
      logger.info("Keyword research: JS expansion done", { seeds: topSeeds.length });
    }

    // ── 5. Claude AI — score and filter the full pool ────────────────────────
    let finalKeywords = [...kwMap.values()];

    if (resolvedTitle && finalKeywords.length > 0) {
      // Only send keywords that don't already have a good relevance score
      const toScore = finalKeywords.filter(
        k => k.relevance_score === undefined || k.relevance_score === null
      );
      if (toScore.length > 0) {
        const scored = await scoreAndFilterKeywords({
          keywords:     toScore,
          productTitle: resolvedTitle,
          locale,
        });
        const scoredMap = new Map(scored.map(k => [k.keyword_text.toLowerCase(), k]));
        finalKeywords = finalKeywords.map(k => {
          const s = scoredMap.get(k.keyword_text.toLowerCase());
          return s ? { ...k, relevance_score: s.relevance_score, suggested_match_types: s.suggested_match_types } : k;
        }).filter(k => (k.relevance_score ?? 50) >= 50);
      }
    }

    // Sort: Amazon highest first (they're most campaign-relevant), then by relevance
    finalKeywords.sort((a, b) => {
      const scoreA = (a.relevance_score || 0) + (a.source === "amazon_ads" ? 15 : 0);
      const scoreB = (b.relevance_score || 0) + (b.source === "amazon_ads" ? 15 : 0);
      return scoreB - scoreA;
    });

    // Set default match_type from first suggested match type
    finalKeywords = finalKeywords.map(k => ({
      ...k,
      match_type: k.suggested_match_types?.[0] || k.match_type || "broad",
    }));

    logger.info("Keyword research complete", {
      workspaceId: req.workspaceId,
      asin: allAsins[0],
      total: finalKeywords.length,
      sources: sourcesUsed,
    });

    res.json({
      keywords:      finalKeywords,
      total:         finalKeywords.length,
      sources_used:  sourcesUsed,
      product_title: resolvedTitle,
      jungle_scout_available: jsConfigured(),
    });
  } catch (err) { next(err); }
});

// ── POST /keyword-research/add-to-adgroup ────────────────────────────────────
router.post("/add-to-adgroup", async (req, res, next) => {
  try {
    const { keywords, adGroupId, defaultBid = 0.50 } = req.body;
    if (!keywords?.length) return res.status(400).json({ error: "keywords required" });
    if (!adGroupId)        return res.status(400).json({ error: "adGroupId required" });

    // Load full ad group + campaign + profile context
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

    let added = 0, skipped = 0;
    const toSync = []; // keywords to push to Amazon API

    for (const kw of keywords) {
      const kwText   = (kw.keyword_text || kw.text || "").trim();
      const matchType = (kw.match_type || "broad").toLowerCase();
      const bid       = Math.max(0.02, parseFloat(kw.bid_suggested || kw.bid || defaultBid));
      if (!kwText) continue;

      // Dedup: skip if same keyword+matchType already exists in this ad group
      const { rows: existing } = await query(
        `SELECT id FROM keywords
         WHERE ad_group_id = $1 AND LOWER(keyword_text) = LOWER($2) AND match_type = $3`,
        [adGroupId, kwText, matchType]
      );
      if (existing.length) { skipped++; continue; }

      const fakeId = `research_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const { rows: [ins] } = await query(
        `INSERT INTO keywords
           (workspace_id, profile_id, campaign_id, ad_group_id,
            amazon_keyword_id, keyword_text, match_type, state, bid)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'enabled',$8)
         ON CONFLICT (profile_id, amazon_keyword_id) DO NOTHING
         RETURNING id, keyword_text, match_type, bid`,
        [req.workspaceId, ag.profile_db_id, ag.campaign_id, adGroupId,
         fakeId, kwText, matchType, bid]
      );

      if (ins) {
        added++;
        toSync.push({
          localId:          ins.id,
          connectionId:     ag.connection_id,
          profileId:        ag.amazon_profile_id?.toString(),
          marketplaceId:    ag.marketplace_id,
          campaignType:     ag.campaign_type,
          amazonCampaignId: ag.amazon_campaign_id,
          amazonAdGroupId:  ag.amazon_ag_id,
          keywordText:      kwText,
          matchType:        matchType.toUpperCase(), // Amazon v3 needs uppercase
          bid,
        });

        await writeAudit({
          orgId: req.orgId, workspaceId: req.workspaceId, actorId: req.user.id, actorName: req.user.name,
          action: "keyword.added", entityType: "keyword",
          entityId: ins.id, entityName: kwText,
          afterData: { keyword_text: kwText, match_type: matchType, bid, ad_group_id: adGroupId },
          source: "ui",
        });
      } else {
        skipped++;
      }
    }

    // Push to Amazon in background (non-fatal)
    if (toSync.length) {
      pushNewKeywords(toSync).catch(e =>
        logger.warn("Keyword research add-to-adgroup write-back failed", { error: e.message })
      );
    }

    logger.info("Keyword research: keywords added", {
      workspaceId: req.workspaceId, adGroupId, added, skipped,
    });

    res.json({ success: true, added, skipped });
  } catch (err) { next(err); }
});

module.exports = router;
