/**
 * Amazon Ads API Write-back Service
 *
 * Provides non-fatal helpers for pushing local changes to Amazon.
 * All functions: update local DB first, then attempt Amazon API write-back.
 * Amazon API errors are logged as warnings but never propagate to callers.
 */

const { query } = require("../../db/pool");
const { put, post } = require("./adsClient");
const logger = require("../../config/logger");

// Batch size Amazon accepts per call
const BATCH_SIZE = 500;

/**
 * Push keyword bid/state updates to Amazon.
 *
 * @param {Array<{amazonKeywordId, campaignType, connectionId, profileId, marketplaceId, bid?, state?}>} updates
 */
async function pushKeywordUpdates(updates) {
  if (!updates?.length) return;

  // Partition by campaign type (SP vs SB have different endpoints)
  const sp = updates.filter(u => u.campaignType === "sponsoredProducts" || u.campaignType === "SP");
  const sb = updates.filter(u => u.campaignType === "sponsoredBrands"   || u.campaignType === "SB");

  // Group by profileId (each profile needs its own API call)
  for (const [profileId, group] of groupBy(sp, "profileId")) {
    const first = group[0];
    if (!first.connectionId || !first.profileId) continue;
    for (let i = 0; i < group.length; i += BATCH_SIZE) {
      const batch = group.slice(i, i + BATCH_SIZE);
      const payload = batch.map(u => {
        const kw = { keywordId: u.amazonKeywordId };
        if (u.bid   !== undefined) kw.bid   = parseFloat(u.bid);
        if (u.state !== undefined) kw.state = u.state.toUpperCase(); // SP v3 requires ENABLED/PAUSED
        return kw;
      });
      try {
        const result = await put({
          connectionId: first.connectionId,
          profileId:    first.profileId.toString(),
          marketplace:  first.marketplaceId,
          path:         "/sp/keywords",
          data:         { keywords: payload },
          group:        "keywords",
        });
        const errors = result?.keywords?.error ?? result?.error ?? [];
        if (errors.length) {
          logger.warn("SP keyword write-back partial errors", { profileId, errors });
        }
        logger.info("SP keyword write-back ok", { profileId, count: batch.length, rejected: errors.length });
      } catch (e) {
        logger.warn("SP keyword write-back failed (non-fatal)", { profileId, error: e.message });
      }
    }
  }

  for (const [profileId, group] of groupBy(sb, "profileId")) {
    const first = group[0];
    if (!first.connectionId || !first.profileId) continue;
    for (let i = 0; i < group.length; i += BATCH_SIZE) {
      const batch = group.slice(i, i + BATCH_SIZE);
      const payload = batch.map(u => {
        const kw = { keywordId: u.amazonKeywordId };
        if (u.bid   !== undefined) kw.bid   = parseFloat(u.bid);
        if (u.state !== undefined) kw.state = u.state.toUpperCase(); // SB also requires uppercase
        return kw;
      });
      try {
        const result = await put({
          connectionId: first.connectionId,
          profileId:    first.profileId.toString(),
          marketplace:  first.marketplaceId,
          path:         "/sb/keywords",
          data:         { keywords: payload },
          group:        "keywords",
        });
        const errors = result?.keywords?.error ?? result?.error ?? [];
        if (errors.length) {
          logger.warn("SB keyword write-back partial errors", { profileId, errors });
        }
        logger.info("SB keyword write-back ok", { profileId, count: batch.length, rejected: errors.length });
      } catch (e) {
        logger.warn("SB keyword write-back failed (non-fatal)", { profileId, error: e.message });
      }
    }
  }
}

/**
 * Push a negative keyword to Amazon SP/SB API, then update the DB record
 * with the real Amazon-assigned ID.
 *
 * @param {object} params
 * @param {string} params.localId          - UUID in negative_keywords table
 * @param {string} params.connectionId
 * @param {string} params.profileId        - Amazon numeric profile ID
 * @param {string} params.marketplaceId
 * @param {string} params.campaignType     - "sponsoredProducts" | "sponsoredBrands"
 * @param {string} params.amazonCampaignId
 * @param {string} params.amazonAdGroupId  - null for campaign-level
 * @param {string} params.keywordText
 * @param {string} params.matchType        - "negativeExact" | "negativePhrase"
 * @param {string} params.level            - "campaign" | "ad_group"
 */
async function pushNegativeKeyword({
  localId, connectionId, profileId, marketplaceId, campaignType,
  amazonCampaignId, amazonAdGroupId, keywordText, matchType, level,
}) {
  if (!connectionId || !profileId) return;

  try {
    const payload = {
      keywordText,
      matchType,
      state: "enabled",
      campaignId: amazonCampaignId,
    };
    if (level === "ad_group" && amazonAdGroupId) {
      payload.adGroupId = amazonAdGroupId;
    }

    let path;
    if (campaignType === "sponsoredProducts" || campaignType === "SP") {
      path = level === "ad_group" ? "/sp/negativeKeywords" : "/sp/campaignNegativeKeywords";
    } else {
      path = "/sb/negativeKeywords";
    }

    const result = await post({
      connectionId,
      profileId: profileId.toString(),
      marketplace: marketplaceId,
      path,
      data: { negativeKeywords: [payload] },
      group: "keywords",
    });

    // Try to extract real Amazon ID from response
    const created = result?.negativeKeywords?.[0] || result?.[0];
    const realId = created?.keywordId || created?.negativeKeywordId;

    if (realId && localId) {
      await query(
        "UPDATE negative_keywords SET amazon_neg_keyword_id = $1 WHERE id = $2",
        [String(realId), localId]
      );
    }

    logger.info("Negative keyword write-back ok", { profileId, path, realId });
  } catch (e) {
    logger.warn("Negative keyword write-back failed (non-fatal)", { profileId, error: e.message });
  }
}

/**
 * Load keyword context (connectionId, profileId, etc.) for a list of local keyword IDs.
 * Returns array of objects needed by pushKeywordUpdates.
 */
async function loadKeywordContext(workspaceId, keywordIds) {
  if (!keywordIds?.length) return [];
  const { rows } = await query(
    `SELECT k.id, k.amazon_keyword_id, k.bid, k.state,
            c.campaign_type, c.amazon_campaign_id,
            p.connection_id,
            p.profile_id AS amazon_profile_id,
            p.marketplace_id
     FROM keywords k
     JOIN campaigns c        ON c.id = k.campaign_id
     JOIN amazon_profiles p  ON p.id = c.profile_id
     WHERE k.id = ANY($1::uuid[]) AND k.workspace_id = $2`,
    [keywordIds, workspaceId]
  );
  return rows;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function groupBy(arr, key) {
  const map = new Map();
  for (const item of arr) {
    const k = item[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map.entries();
}

/**
 * Push a negative ASIN (target) to Amazon SP API, then update the DB record
 * with the real Amazon-assigned ID.
 *
 * @param {object} params
 * @param {string} params.localId           - UUID in negative_targets table
 * @param {string} params.connectionId
 * @param {string} params.profileId         - Amazon numeric profile ID
 * @param {string} params.marketplaceId
 * @param {string} params.campaignType      - "sponsoredProducts" | "sponsoredBrands"
 * @param {string} params.amazonCampaignId
 * @param {string} params.amazonAdGroupId   - null for campaign-level
 * @param {string} params.asinValue         - e.g. "B00XXXXX"
 * @param {string} params.level             - "campaign" | "ad_group"
 */
async function pushNegativeAsin({
  localId, connectionId, profileId, marketplaceId, campaignType,
  amazonCampaignId, amazonAdGroupId, asinValue, level,
}) {
  if (!connectionId || !profileId) return;

  try {
    const expression = [{ type: "asinSameAs", value: asinValue }];
    const payload = {
      expression,
      expressionType: "manual",
      state: "enabled",
      campaignId: amazonCampaignId,
    };
    if (level === "ad_group" && amazonAdGroupId) {
      payload.adGroupId = amazonAdGroupId;
    }

    // SP negative targets endpoint; SD uses /sd/negativeTargets but rare for manual adds
    const path = "/sp/negativeTargets";

    const result = await post({
      connectionId,
      profileId: profileId.toString(),
      marketplace: marketplaceId,
      path,
      data: { negativeTargetingClauses: [payload] },
      group: "keywords",
    });

    const created = result?.negativeTargetingClauses?.[0] || result?.[0];
    const realId = created?.targetId || created?.negativeTargetId;

    if (realId && localId) {
      await query(
        "UPDATE negative_targets SET amazon_neg_target_id = $1 WHERE id = $2",
        [String(realId), localId]
      );
    }

    logger.info("Negative ASIN write-back ok", { profileId, path, realId });
  } catch (e) {
    logger.warn("Negative ASIN write-back failed (non-fatal)", { profileId, error: e.message });
  }
}

module.exports = { pushKeywordUpdates, pushNegativeKeyword, pushNegativeAsin, loadKeywordContext };
