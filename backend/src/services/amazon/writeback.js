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
 * Detect Amazon "already exists" rejections (duplicateValueError / DUPLICATE_VALUE).
 * Adding a negative that already exists is idempotent — the desired end-state
 * (the negative is present on Amazon) is already satisfied, so we treat it as
 * success rather than an error. Without this, a previously-created negative whose
 * local id was lost (e.g. a write-back that failed during an outage and is retried)
 * would re-fail every run and pollute the audit log with phantom errors.
 */
function isDuplicateError(msg) {
  if (!msg) return false;
  const s = String(msg);
  return /duplicateValueError|DUPLICATE_VALUE|already exists/i.test(s);
}

/**
 * Extract a per-item rejection from an Amazon Ads v3 batch response.
 *
 * These endpoints answer 207 Multi-Status: the HTTP status is 2xx (adsClient returns the
 * body rather than throwing) while individual items are reported in `<dataKey>.error[]`.
 * Callers that only catch thrown errors therefore treat a refused write as a success.
 * Returns a message string when the batch reported an error, otherwise null.
 */
function partialError(result, dataKey) {
  const errors = result?.[dataKey]?.error;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0];
  return first?.description || first?.message || JSON.stringify(first);
}

/**
 * Recover the real Amazon id of a negative keyword after a "duplicate" rejection —
 * the earlier negative was PAUSED (not deleted) by archiveNegativeKeyword, so Amazon
 * still holds it under its original id and rejects a fresh create as a dupe. Without
 * this lookup the local row keeps its `rule-*` placeholder id forever, which then
 * blocks any future archive/re-enable of it (see hasRealId guards in routes/rules.js).
 * SP only — matches the scope of the existing entities.js sync (SB negatives aren't synced).
 */
async function findExistingNegativeKeyword({ connectionId, profileId, marketplaceId, path, dataKey, amazonCampaignId, amazonAdGroupId, keywordText, matchType, level }) {
  if (!path.startsWith("/sp/")) return null; // SB negatives aren't listable via this path today
  try {
    let nextToken = null;
    let page = 0;
    do {
      const body = { stateFilter: { include: ["ENABLED", "PAUSED", "ARCHIVED"] }, maxResults: 500 };
      if (nextToken) body.nextToken = nextToken;
      const result = await post({
        connectionId, profileId: profileId.toString(), marketplace: marketplaceId,
        path: `${path}/list`, data: body, group: "keywords",
      });
      const items = result?.[dataKey] || [];
      const match = items.find((kw) =>
        String(kw.campaignId) === String(amazonCampaignId) &&
        (level !== "ad_group" || String(kw.adGroupId) === String(amazonAdGroupId)) &&
        String(kw.keywordText || "").toLowerCase() === String(keywordText || "").toLowerCase() &&
        String(kw.matchType || "").toUpperCase() === String(matchType || "").toUpperCase()
      );
      if (match) return { id: match.keywordId, state: match.state };
      nextToken = result?.nextToken || null;
      page++;
    } while (nextToken && page < 20);
    return null;
  } catch (e) {
    logger.warn("findExistingNegativeKeyword lookup failed", { profileId, path, error: e.message });
    return null;
  }
}

/**
 * Same recovery as findExistingNegativeKeyword, for negative targeting clauses (ASINs).
 */
async function findExistingNegativeTarget({ connectionId, profileId, marketplaceId, amazonCampaignId, amazonAdGroupId, asinValue }) {
  try {
    let nextToken = null;
    let page = 0;
    do {
      const body = { stateFilter: { include: ["ENABLED", "PAUSED", "ARCHIVED"] }, maxResults: 500 };
      if (nextToken) body.nextToken = nextToken;
      const result = await post({
        connectionId, profileId: profileId.toString(), marketplace: marketplaceId,
        path: "/sp/negativeTargets/list", data: body, group: "keywords",
      });
      const items = result?.negativeTargetingClauses || [];
      const match = items.find((t) =>
        String(t.campaignId) === String(amazonCampaignId) &&
        (!amazonAdGroupId || String(t.adGroupId) === String(amazonAdGroupId)) &&
        (t.expression || []).some((e) => e.type === "ASIN_SAME_AS" && String(e.value).toUpperCase() === String(asinValue).toUpperCase())
      );
      if (match) return { id: match.targetId, state: match.state };
      nextToken = result?.nextToken || null;
      page++;
    } while (nextToken && page < 20);
    return null;
  } catch (e) {
    logger.warn("findExistingNegativeTarget lookup failed", { profileId, error: e.message });
    return null;
  }
}

/**
 * Push keyword bid/state updates to Amazon.
 *
 * @param {Array<{amazonKeywordId, campaignType, connectionId, profileId, marketplaceId, bid?, state?}>} updates
 */
async function pushKeywordUpdates(updates) {
  if (!updates?.length) return { ok: true };

  let anyError = null;
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
          anyError = errors[0]?.description || errors[0]?.message || JSON.stringify(errors[0]);
        }
        logger.info("SP keyword write-back ok", { profileId, count: batch.length, rejected: errors.length });
      } catch (e) {
        logger.warn("SP keyword write-back failed (non-fatal)", { profileId, error: e.message });
        anyError = e.message;
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
          anyError = errors[0]?.description || errors[0]?.message || JSON.stringify(errors[0]);
        }
        logger.info("SB keyword write-back ok", { profileId, count: batch.length, rejected: errors.length });
      } catch (e) {
        logger.warn("SB keyword write-back failed (non-fatal)", { profileId, error: e.message });
        anyError = e.message;
      }
    }
  }
  return anyError ? { ok: false, error: anyError } : { ok: true };
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
  if (!connectionId || !profileId) return { ok: false, error: "No Amazon connection" };

  // SP v3 API requires SCREAMING_SNAKE_CASE enums for both endpoints
  const MT_MAP = {
    negativeExact:  "NEGATIVE_EXACT",
    negativePhrase: "NEGATIVE_PHRASE",
    NEGATIVE_EXACT:  "NEGATIVE_EXACT",
    NEGATIVE_PHRASE: "NEGATIVE_PHRASE",
  };
  const amazonMatchType = MT_MAP[matchType] || matchType.toUpperCase();

  let path;
  let dataKey;
  if (campaignType === "sponsoredProducts" || campaignType === "SP") {
    if (level === "ad_group") {
      path = "/sp/negativeKeywords";
      dataKey = "negativeKeywords";
    } else {
      path = "/sp/campaignNegativeKeywords";
      dataKey = "campaignNegativeKeywords";
    }
  } else {
    path = "/sb/negativeKeywords";
    dataKey = "negativeKeywords";
  }

  try {
    const payload = {
      keywordText,
      matchType: amazonMatchType,
      state: "ENABLED",
      campaignId: amazonCampaignId,
    };
    if (level === "ad_group" && amazonAdGroupId) {
      payload.adGroupId = amazonAdGroupId;
    }

    const result = await post({
      connectionId,
      profileId: profileId.toString(),
      marketplace: marketplaceId,
      path,
      data: { [dataKey]: [payload] },
      group: "keywords",
    });

    // v3 API returns { <dataKey>: { success: [...], error: [...] } }
    const created = result?.[dataKey]?.success?.[0]
      || result?.[dataKey]?.[0]
      || result?.[0];
    const realId = created?.negativeKeywordId || created?.campaignNegativeKeywordId || created?.keywordId;

    if (realId && localId) {
      await query(
        "UPDATE negative_keywords SET amazon_neg_keyword_id = $1 WHERE id = $2",
        [String(realId), localId]
      );
    }

    if (!realId) {
      const errors = result?.[dataKey]?.error || [];
      const errMsg = errors[0]?.description || errors[0]?.message || (errors.length ? JSON.stringify(errors[0]) : null);
      if (isDuplicateError(errMsg)) {
        return recoverDuplicateNegativeKeyword({
          connectionId, profileId, marketplaceId, path, dataKey, localId,
          amazonCampaignId, amazonAdGroupId, keywordText, matchType: amazonMatchType, level,
        });
      }
      logger.warn("Negative keyword rejected by Amazon", { profileId, path, amazonError: errMsg });
      return { ok: false, error: errMsg || "no realId in response" };
    }

    logger.info("Negative keyword write-back ok", { profileId, path, realId });
    return { ok: true };
  } catch (e) {
    if (isDuplicateError(e.message)) {
      return recoverDuplicateNegativeKeyword({
        connectionId, profileId, marketplaceId, path, dataKey, localId,
        amazonCampaignId, amazonAdGroupId, keywordText, matchType: amazonMatchType, level,
      });
    }
    logger.warn("Negative keyword write-back failed (non-fatal)", { profileId, error: e.message });
    return { ok: false, error: e.message };
  }
}

/**
 * On a duplicate rejection, look up the existing negative's real id, backfill it locally,
 * and re-enable it on Amazon if it was left PAUSED from an earlier archive — otherwise
 * this "add" silently no-ops forever (see findExistingNegativeKeyword doc comment).
 */
async function recoverDuplicateNegativeKeyword({ connectionId, profileId, marketplaceId, path, dataKey, localId, amazonCampaignId, amazonAdGroupId, keywordText, matchType, level }) {
  logger.info("Negative keyword already exists on Amazon (idempotent) — recovering real id", { profileId, path, keywordText });
  const existing = await findExistingNegativeKeyword({
    connectionId, profileId, marketplaceId, path, dataKey, amazonCampaignId, amazonAdGroupId, keywordText, matchType, level,
  });
  if (!existing?.id) {
    logger.warn("Duplicate negative keyword but lookup could not recover its id", { profileId, path, keywordText });
    return { ok: true, duplicate: true };
  }
  if (localId) {
    // The periodic entity sync may have already created its own row for this real id
    // (upserted on (profile_id, amazon_neg_keyword_id)). If so, this placeholder row is a
    // redundant duplicate of it — drop the placeholder rather than violate the unique index.
    await query("UPDATE negative_keywords SET amazon_neg_keyword_id = $1 WHERE id = $2", [String(existing.id), localId])
      .catch(async (e) => {
        if (e.code !== "23505") throw e;
        logger.info("Duplicate neg keyword real id already tracked by a synced row — dropping placeholder", { profileId, localId, realId: existing.id });
        await query("DELETE FROM negative_keywords WHERE id = $1", [localId]);
      });
  }
  if (existing.state && existing.state !== "ENABLED") {
    await put({
      connectionId, profileId: profileId.toString(), marketplace: marketplaceId,
      path, data: { [dataKey]: [{ keywordId: existing.id, state: "ENABLED" }] }, group: "keywords",
    }).catch((e) => logger.warn("Re-enable duplicate negative keyword failed", { profileId, keywordId: existing.id, error: e.message }));
  }
  return { ok: true, duplicate: true, realId: existing.id };
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

/**
 * Build the campaign-mutation fields for a daily budget, per campaign type.
 *
 * SP and SB v3 both model the budget as a nested object; there is no `dailyBudget`
 * field in the v3 campaign schema (a GET returns `budget: {budget, budgetType}`).
 * Sending the v2-style flat `dailyBudget` is not rejected — Amazon ignores the unknown
 * field and still answers 207 with the campaign in `success[]`, so the caller records a
 * successful write while the budget on Amazon never changes. That silently no-op'd every
 * SP budget write-back (rules and the campaign edit form alike) until 2026-08-10.
 * SD is the exception: its PUT is still v2-style (flat budget, lowercase budgetType).
 *
 * Returns a fragment to merge into the campaign object — never a whole payload.
 */
function campaignBudgetFields(campaignType, dailyBudget) {
  const budget = parseFloat(dailyBudget);
  if (!Number.isFinite(budget)) return {};
  return campaignType === "sponsoredDisplay"
    ? { budget, budgetType: "daily" }
    : { budget: { budget, budgetType: "DAILY" } };
}

/**
 * SP/SB wrap campaign mutations in `{campaigns: [...]}`; SD (v2-style PUT) takes a bare array.
 */
function wrapCampaigns(campaignType, items) {
  return campaignType === "sponsoredDisplay" ? items : { campaigns: items };
}

/**
 * Push campaign state and/or daily-budget changes to Amazon.
 *
 * Mirrors pushKeywordUpdates: non-fatal, batched per profile, and resolves to
 * `{ok:false, error}` on a 207 partial rejection rather than throwing.
 *
 * @param {Array<object>} updates - {amazonCampaignId, campaignType, connectionId,
 *   profileId, marketplaceId, state?, dailyBudget?}
 */
async function pushCampaignUpdates(updates) {
  if (!updates?.length) return { ok: true };

  let anyError = null;
  const PATHS = {
    sponsoredProducts: "/sp/campaigns",
    sponsoredBrands:   "/sb/campaigns",
    sponsoredDisplay:  "/sd/campaigns",
  };

  for (const [campaignType, byType] of groupBy(updates, "campaignType")) {
    const path = PATHS[campaignType];
    if (!path) {
      anyError = `Unsupported campaign type: ${campaignType}`;
      logger.warn("Campaign write-back skipped: unknown type", { campaignType });
      continue;
    }
    const isSD = campaignType === "sponsoredDisplay";

    for (const [profileId, group] of groupBy(byType, "profileId")) {
      const first = group[0];
      if (!first.connectionId || !first.profileId) continue;

      for (let i = 0; i < group.length; i += BATCH_SIZE) {
        const batch = group.slice(i, i + BATCH_SIZE);
        const items = batch.map(u => {
          const c = { campaignId: u.amazonCampaignId };
          // SP/SB expect uppercase state (ENABLED); SD (v2-style) expects lowercase.
          if (u.state !== undefined) c.state = isSD ? u.state.toLowerCase() : u.state.toUpperCase();
          if (u.dailyBudget !== undefined) Object.assign(c, campaignBudgetFields(campaignType, u.dailyBudget));
          return c;
        });
        try {
          const result = await put({
            connectionId: first.connectionId,
            profileId:    String(first.profileId),
            marketplace:  first.marketplaceId,
            path,
            data:         wrapCampaigns(campaignType, items),
            group:        "campaigns",
          });
          const err = partialError(result, "campaigns");
          if (err) {
            logger.warn("Campaign write-back partial errors", { profileId, campaignType, error: err });
            anyError = err;
          } else {
            logger.info("Campaign write-back ok", { profileId, campaignType, count: batch.length });
          }
        } catch (e) {
          logger.warn("Campaign write-back failed (non-fatal)", { profileId, campaignType, error: e.message });
          anyError = e.message;
        }
      }
    }
  }
  return anyError ? { ok: false, error: anyError } : { ok: true };
}

/**
 * Push ad-group state and/or default-bid changes to Amazon.
 * Same contract as pushCampaignUpdates: non-fatal, 207-aware, resolves to {ok,error}.
 *
 * @param {Array<object>} updates - {amazonAdGroupId, campaignType, connectionId,
 *   profileId, marketplaceId, state?, defaultBid?}
 */
async function pushAdGroupUpdates(updates) {
  if (!updates?.length) return { ok: true };

  let anyError = null;
  const PATHS = {
    sponsoredProducts: "/sp/adGroups",
    sponsoredBrands:   "/sb/adGroups",
    sponsoredDisplay:  "/sd/adGroups",
  };

  for (const [campaignType, byType] of groupBy(updates, "campaignType")) {
    const path = PATHS[campaignType];
    if (!path) {
      anyError = `Unsupported campaign type: ${campaignType}`;
      continue;
    }
    for (const [profileId, group] of groupBy(byType, "profileId")) {
      const first = group[0];
      if (!first.connectionId || !first.profileId) continue;

      for (let i = 0; i < group.length; i += BATCH_SIZE) {
        const batch = group.slice(i, i + BATCH_SIZE);
        const items = batch.map(u => {
          const ag = { adGroupId: u.amazonAdGroupId };
          if (u.state !== undefined)      ag.state      = u.state.toUpperCase();
          if (u.defaultBid !== undefined) ag.defaultBid = parseFloat(u.defaultBid);
          return ag;
        });
        try {
          const result = await put({
            connectionId: first.connectionId,
            profileId:    String(first.profileId),
            marketplace:  first.marketplaceId,
            path,
            data:         { adGroups: items },
            group:        "ad_groups",
          });
          const err = partialError(result, "adGroups");
          if (err) {
            logger.warn("Ad group write-back partial errors", { profileId, campaignType, error: err });
            anyError = err;
          } else {
            logger.info("Ad group write-back ok", { profileId, campaignType, count: batch.length });
          }
        } catch (e) {
          logger.warn("Ad group write-back failed (non-fatal)", { profileId, campaignType, error: e.message });
          anyError = e.message;
        }
      }
    }
  }
  return anyError ? { ok: false, error: anyError } : { ok: true };
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
  if (!connectionId || !profileId) return { ok: false, error: "No Amazon connection" };

  try {
    // SP v3 API requires SCREAMING_SNAKE_CASE for expression type and UPPERCASE state
    const expression = [{ type: "ASIN_SAME_AS", value: asinValue }];
    const payload = {
      expression,
      expressionType: "manual",
      state: "ENABLED",
      campaignId: amazonCampaignId,
    };
    // sp/negativeTargets always requires adGroupId (campaign-level negatives not supported via this endpoint)
    if (amazonAdGroupId) {
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

    // v3 API returns { negativeTargetingClauses: { success: [...], error: [...] } }
    const created = result?.negativeTargetingClauses?.success?.[0]
      || result?.negativeTargetingClauses?.[0]
      || result?.[0];
    const realId = created?.negativeTargetId || created?.targetId;

    if (!realId) {
      const errors = result?.negativeTargetingClauses?.error || [];
      if (errors.length > 0) {
        const errMsg = errors[0]?.description || errors[0]?.message || JSON.stringify(errors[0]);
        if (isDuplicateError(errMsg)) {
          return recoverDuplicateNegativeTarget({ connectionId, profileId, marketplaceId, localId, amazonCampaignId, amazonAdGroupId, asinValue });
        }
        logger.warn("Negative ASIN rejected by Amazon", { profileId, path, amazonError: errMsg });
        return { ok: false, error: errMsg };
      }
      logger.warn("Negative ASIN write-back: no realId in response", { profileId, path });
      return { ok: false, error: "no realId in response" };
    }

    if (localId) {
      await query(
        "UPDATE negative_targets SET amazon_neg_target_id = $1 WHERE id = $2",
        [String(realId), localId]
      );
    }

    logger.info("Negative ASIN write-back ok", { profileId, path, realId });
    return { ok: true };
  } catch (e) {
    if (isDuplicateError(e.message)) {
      return recoverDuplicateNegativeTarget({ connectionId, profileId, marketplaceId, localId, amazonCampaignId, amazonAdGroupId, asinValue });
    }
    logger.warn("Negative ASIN write-back failed (non-fatal)", { profileId, error: e.message });
    return { ok: false, error: e.message };
  }
}

/**
 * On a duplicate rejection, look up the existing negative target's real id, backfill it
 * locally, and re-enable it on Amazon if it was left PAUSED from an earlier archive.
 */
async function recoverDuplicateNegativeTarget({ connectionId, profileId, marketplaceId, localId, amazonCampaignId, amazonAdGroupId, asinValue }) {
  logger.info("Negative ASIN already exists on Amazon (idempotent) — recovering real id", { profileId, asinValue });
  const existing = await findExistingNegativeTarget({ connectionId, profileId, marketplaceId, amazonCampaignId, amazonAdGroupId, asinValue });
  if (!existing?.id) {
    logger.warn("Duplicate negative ASIN but lookup could not recover its id", { profileId, asinValue });
    return { ok: true, duplicate: true };
  }
  if (localId) {
    await query("UPDATE negative_targets SET amazon_neg_target_id = $1 WHERE id = $2", [String(existing.id), localId])
      .catch(async (e) => {
        if (e.code !== "23505") throw e;
        logger.info("Duplicate neg target real id already tracked by a synced row — dropping placeholder", { profileId, localId, realId: existing.id });
        await query("DELETE FROM negative_targets WHERE id = $1", [localId]);
      });
  }
  if (existing.state && existing.state !== "ENABLED") {
    await put({
      connectionId, profileId: profileId.toString(), marketplace: marketplaceId,
      path: "/sp/negativeTargets", data: { negativeTargetingClauses: [{ targetId: existing.id, state: "ENABLED" }] }, group: "keywords",
    }).catch((e) => logger.warn("Re-enable duplicate negative target failed", { profileId, targetId: existing.id, error: e.message }));
  }
  return { ok: true, duplicate: true, realId: existing.id };
}

/**
 * Create new keywords in Amazon Ads API (SP only for now).
 * Called after inserting keywords locally — updates local DB with real Amazon keyword IDs.
 *
 * @param {Array<{localId, connectionId, profileId, marketplaceId, campaignType,
 *                amazonCampaignId, amazonAdGroupId, keywordText, matchType, bid}>} keywords
 */
async function pushNewKeywords(keywords) {
  if (!keywords?.length) return { ok: true };
  let anyError = null;

  const sp = keywords.filter(k =>
    k.campaignType === "sponsoredProducts" || k.campaignType === "SP"
  );
  // SB keyword creation uses different schema — skip for now (add later if needed)

  for (const [profileId, group] of groupBy(sp, "profileId")) {
    const first = group[0];
    if (!first.connectionId || !first.profileId) continue;

    for (let i = 0; i < group.length; i += BATCH_SIZE) {
      const batch = group.slice(i, i + BATCH_SIZE);
      const payload = batch.map(k => ({
        campaignId:  k.amazonCampaignId,
        adGroupId:   k.amazonAdGroupId,
        keywordText: k.keywordText,
        matchType:   (k.matchType || "BROAD").toUpperCase(), // Amazon v3: EXACT/PHRASE/BROAD
        state:       "ENABLED",
        bid:         parseFloat(k.bid) || 0.50,
      }));

      try {
        const result = await post({
          connectionId: first.connectionId,
          profileId:    first.profileId.toString(),
          marketplace:  first.marketplaceId,
          path:         "/sp/keywords",
          data:         { keywords: payload },
          group:        "keywords",
        });

        // Update local DB records with real Amazon keyword IDs
        const successArr = result?.keywords?.success || [];
        for (const created of successArr) {
          const realId  = created?.keywordId;
          const kwText  = (created?.keywordText || "").toLowerCase();
          if (!realId) continue;
          const localKw = batch.find(k => k.keywordText.toLowerCase() === kwText);
          if (localKw?.localId) {
            await query(
              "UPDATE keywords SET amazon_keyword_id = $1 WHERE id = $2",
              [String(realId), localKw.localId]
            ).catch(() => {});
          }
        }

        const errors = result?.keywords?.error ?? [];
        if (errors.length) {
          logger.warn("SP keyword create partial errors", { profileId, errors });
        }
        logger.info("SP keyword create ok", { profileId, count: batch.length, rejected: errors.length });
      } catch (e) {
        logger.warn("SP keyword create failed (non-fatal)", { profileId, error: e.message });
        anyError = e.message;
      }
    }
  }
  return anyError ? { ok: false, error: anyError } : { ok: true };
}

/**
 * Archive (ARCHIVED state) a negative keyword in Amazon, then mark local row archived.
 */
async function archiveNegativeKeyword({ localId, connectionId, profileId, marketplaceId, campaignType, level, amazonNegKeywordId }) {
  if (!connectionId || !profileId || !amazonNegKeywordId) return { ok: false, error: "Missing params" };
  try {
    const isAdGroup = level !== "campaign";
    const isSB = campaignType === "sponsoredBrands" || campaignType === "SB";
    const path = isAdGroup
      ? (isSB ? "/sb/negativeKeywords" : "/sp/negativeKeywords")
      : "/sp/campaignNegativeKeywords";
    const dataKey = isAdGroup ? "negativeKeywords" : "campaignNegativeKeywords";
    // Amazon SP/SB PUT body uses "keywordId" (not "negativeKeywordId") as the identifier field.
    // Campaign-level negative keywords use "keywordId" as well per Amazon Ads API.
    // The `state` field only accepts ENABLED/PROPOSED/PAUSED — "archived" is rejected with
    // a 400 INVALID_ARGUMENT. Setting state=PAUSED deactivates the negative (stops it blocking
    // traffic), matching how negative *targets* are deactivated. Local row is still marked
    // 'archived' below for our own bookkeeping.
    const idKey   = "keywordId";
    const result = await put({
      connectionId, profileId: profileId.toString(), marketplace: marketplaceId,
      path, data: { [dataKey]: [{ [idKey]: amazonNegKeywordId, state: "PAUSED" }] }, group: "keywords",
    });
    // Amazon's batch endpoints answer 207 Multi-Status: the HTTP call succeeds while individual
    // items are rejected in the body. adsClient treats every 2xx as success, so without this
    // check a refused archive was reported as `ok` and the audit trail recorded "success"
    // for a change that never happened.
    const err = partialError(result, dataKey);
    if (err) {
      logger.warn("Negative keyword archive rejected by Amazon", { profileId, path, amazonNegKeywordId, amazonError: err });
      return { ok: false, error: err };
    }
    if (localId) {
      await query("UPDATE negative_keywords SET state='archived' WHERE id=$1", [localId]);
    }
    logger.info("Negative keyword archived", { profileId, path, amazonNegKeywordId });
    return { ok: true };
  } catch (e) {
    logger.warn("Archive negative keyword failed (non-fatal)", { profileId, error: e.message });
    return { ok: false, error: e.message };
  }
}

/**
 * Deactivate a negative target in Amazon, then mark local row archived.
 * SP negative targets do not support state=ARCHIVED via PUT (valid: ENABLED/PROPOSED/PAUSED).
 * We set state=PAUSED which deactivates the target without requiring a separate DELETE endpoint.
 * Field name in PUT body is "targetId" (not "negativeTargetId") per Amazon Ads API v3.
 */
async function archiveNegativeTarget({ localId, connectionId, profileId, marketplaceId, campaignType, amazonNegTargetId }) {
  if (!connectionId || !profileId || !amazonNegTargetId) return { ok: false, error: "Missing params" };
  try {
    const path = campaignType === "sponsoredDisplay" || campaignType === "SD"
      ? "/sd/negativeTargets" : "/sp/negativeTargets";
    const result = await put({
      connectionId, profileId: profileId.toString(), marketplace: marketplaceId,
      path, data: { negativeTargetingClauses: [{ targetId: amazonNegTargetId, state: "PAUSED" }] },
      group: "keywords",
    });
    // See archiveNegativeKeyword — 207 Multi-Status hides per-item rejections behind a 2xx.
    const err = partialError(result, "negativeTargetingClauses");
    if (err) {
      logger.warn("Negative target archive rejected by Amazon", { profileId, path, amazonNegTargetId, amazonError: err });
      return { ok: false, error: err };
    }
    if (localId) {
      await query("UPDATE negative_targets SET state='archived' WHERE id=$1", [localId]);
    }
    logger.info("Negative target paused/archived", { profileId, path, amazonNegTargetId });
    return { ok: true };
  } catch (e) {
    logger.warn("Archive negative target failed (non-fatal)", { profileId, error: e.message });
    return { ok: false, error: e.message };
  }
}

module.exports = {
  pushKeywordUpdates, pushNegativeKeyword, pushNegativeAsin, loadKeywordContext,
  pushNewKeywords, archiveNegativeKeyword, archiveNegativeTarget,
  pushCampaignUpdates, pushAdGroupUpdates, campaignBudgetFields, wrapCampaigns, partialError,
};
