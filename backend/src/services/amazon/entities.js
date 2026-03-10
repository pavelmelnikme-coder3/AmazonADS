/**
 * Amazon Ads Entity Services
 * Fetches and syncs: Profiles, Campaigns, Ad Groups, Keywords,
 *                    Portfolios, Product Ads, Targets, Negative Keywords, Negative Targets
 *
 * All operations use the centralized adsClient with rate limiting.
 */

const { get, getAll } = require("./adsClient");
const { query, withTransaction } = require("../../db/pool");
const logger = require("../../config/logger");

// ─── API Base URLs by region ──────────────────────────────────────────────────
const REGION_URLS = {
  NA: process.env.AMAZON_ADS_API_URL    || "https://advertising-api.amazon.com",
  EU: process.env.AMAZON_ADS_API_EU_URL || "https://advertising-api-eu.amazon.com",
  FE: process.env.AMAZON_ADS_API_FE_URL || "https://advertising-api-fe.amazon.com",
};

// ─── PROFILES ─────────────────────────────────────────────────────────────────

async function fetchProfiles(connectionId) {
  const { rows: [conn] } = await query(
    "SELECT id, org_id, region FROM amazon_connections WHERE id = $1",
    [connectionId]
  );
  if (!conn) throw new Error("Connection not found");

  const { getValidAccessToken } = require("./lwa");
  const axios = require("axios");
  const accessToken = await getValidAccessToken(connectionId);

  const storedRegion = conn.region || "EU";
  const regionsToTry = [storedRegion, ...Object.keys(REGION_URLS).filter(r => r !== storedRegion)];

  let allProfiles = [];
  let successRegion = null;

  for (const region of regionsToTry) {
    try {
      const baseUrl = REGION_URLS[region];
      const response = await axios.get(`${baseUrl}/v2/profiles`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Amazon-Advertising-API-ClientId": process.env.AMAZON_CLIENT_ID,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      });
      if (response.data?.length > 0) {
        allProfiles = response.data;
        successRegion = region;
        logger.info("Profiles fetched", { connectionId, region, count: allProfiles.length });
        break;
      }
    } catch (err) {
      logger.warn(`Failed to fetch profiles from ${region}`, { error: err.message });
    }
  }

  if (successRegion && successRegion !== storedRegion) {
    await query("UPDATE amazon_connections SET region = $1 WHERE id = $2", [successRegion, connectionId]);
  }

  return allProfiles;
}

async function upsertProfiles(connectionId, profiles) {
  const saved = [];
  for (const p of profiles) {
    const { rows } = await query(
      `INSERT INTO amazon_profiles
         (connection_id, profile_id, marketplace_id, marketplace, country_code, currency_code,
          timezone, account_name, account_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (connection_id, profile_id)
       DO UPDATE SET
         marketplace_id = EXCLUDED.marketplace_id,
         marketplace = EXCLUDED.marketplace,
         country_code = EXCLUDED.country_code,
         currency_code = EXCLUDED.currency_code,
         timezone = EXCLUDED.timezone,
         account_name = EXCLUDED.account_name,
         account_type = EXCLUDED.account_type,
         updated_at = NOW()
       RETURNING *`,
      [
        connectionId,
        p.profileId,
        p.countryCode === "US" ? "ATVPDKIKX0DER" : p.marketplaceStringId || "",
        p.countryCode,
        p.countryCode,
        p.currencyCode || "USD",
        p.timezone || "UTC",
        p.accountInfo?.name || null,
        p.accountInfo?.type || null,
      ]
    );
    saved.push(rows[0]);
  }
  return saved;
}

async function attachProfileToWorkspace(profileDbId, workspaceId) {
  await query(
    `UPDATE amazon_profiles
     SET workspace_id = $1, is_attached = TRUE, sync_status = 'pending', updated_at = NOW()
     WHERE id = $2`,
    [workspaceId, profileDbId]
  );
}

// ─── Shared base opts helper ──────────────────────────────────────────────────
function baseOpts(profile) {
  return {
    connectionId: profile.connection_id,
    profileId: String(profile.profile_id),
    marketplace: profile.marketplace_id,
    countryCode: profile.country_code || profile.marketplace,
  };
}

// ─── CAMPAIGNS ────────────────────────────────────────────────────────────────

async function fetchCampaigns(profile) {
  const { getValidAccessToken } = require("./lwa");
  const axios = require("axios");

  const COUNTRY_REGION = {
    US: "NA", CA: "NA", MX: "NA",
    GB: "EU", UK: "EU", DE: "EU", FR: "EU", IT: "EU", ES: "EU",
    NL: "EU", SE: "EU", PL: "EU", TR: "EU", SA: "EU", AE: "EU", BE: "EU",
    JP: "FE", AU: "FE", SG: "FE", IN: "FE",
  };
  const API_URLS = {
    NA: process.env.AMAZON_ADS_API_URL    || "https://advertising-api.amazon.com",
    EU: process.env.AMAZON_ADS_API_EU_URL || "https://advertising-api-eu.amazon.com",
    FE: process.env.AMAZON_ADS_API_FE_URL || "https://advertising-api-fe.amazon.com",
  };
  const resolvedRegion = COUNTRY_REGION[(profile.country_code || "").toUpperCase()] || "EU";
  const baseUrl = (API_URLS[resolvedRegion] || "https://advertising-api-eu.amazon.com").replace(/^http:\/\//i, "https://");

  const base = baseOpts(profile);

  // --- SP Campaigns via POST /sp/campaigns/list ---
  const spCampaigns = [];
  try {
    const accessToken = await getValidAccessToken(profile.connection_id);
    const mediaType = "application/vnd.spCampaign.v3+json";
    let nextToken = null;
    let page = 0;
    do {
      const body = {
        stateFilter: { include: ["ENABLED", "PAUSED", "ARCHIVED"] },
        maxResults: 100,
      };
      if (nextToken) body.nextToken = nextToken;

      const response = await axios.post(`${baseUrl}/sp/campaigns/list`, body, {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Amazon-Advertising-API-ClientId": process.env.AMAZON_CLIENT_ID,
          "Amazon-Advertising-API-Scope": String(profile.profile_id),
          "Content-Type": mediaType,
          "Accept": mediaType,
        },
        timeout: 30000,
      });

      const data = response.data;
      const batch = Array.isArray(data.campaigns) ? data.campaigns : [];
      batch.forEach(c => { c.campaignType = "sponsoredProducts"; });
      spCampaigns.push(...batch);
      nextToken = data.nextToken || null;
      page++;
      logger.info("SP campaigns list page", { profileId: profile.profile_id, page, count: batch.length, total: data.totalResults, hasMore: !!nextToken });
    } while (nextToken && page < 400);

    logger.info("SP campaigns fetch complete", { profileId: profile.profile_id, total: spCampaigns.length });
  } catch (err) {
    logger.error("SP campaigns list failed", {
      profileId: profile.profile_id,
      status: err.response?.status,
      error: JSON.stringify(err.response?.data) || err.message,
    });
  }

  // --- SB Campaigns (still GET-based, v4) ---
  let sbCampaigns = [];
  try {
    sbCampaigns = (await getAll({ ...base, path: "/sb/v4/campaigns", params: { stateFilter: "enabled,paused,archived" }, group: "campaigns", responseKey: "campaigns" }))
      .map(c => ({ ...c, campaignType: "sponsoredBrands" }));
    logger.info("SB campaigns fetch complete", { profileId: profile.profile_id, total: sbCampaigns.length });
  } catch (err) {
    const status = err.status || err.response?.status;
    if ([401, 403, 404].includes(status)) logger.info("SB campaigns skipped", { profileId: profile.profile_id, status });
    else logger.warn("SB campaigns failed", { profileId: profile.profile_id, error: err.message });
  }

  // --- SD Campaigns (still GET-based) ---
  let sdCampaigns = [];
  try {
    sdCampaigns = (await getAll({ ...base, path: "/sd/campaigns", params: { stateFilter: "enabled,paused,archived" }, group: "campaigns", responseKey: "campaigns" }))
      .map(c => ({ ...c, campaignType: "sponsoredDisplay" }));
    logger.info("SD campaigns fetch complete", { profileId: profile.profile_id, total: sdCampaigns.length });
  } catch (err) {
    const status = err.status || err.response?.status;
    if ([401, 403, 404].includes(status)) logger.info("SD campaigns skipped", { profileId: profile.profile_id, status });
    else logger.warn("SD campaigns failed", { profileId: profile.profile_id, error: err.message });
  }

  const all = [...spCampaigns, ...sbCampaigns, ...sdCampaigns];
  logger.info("fetchCampaigns complete", { profileId: profile.profile_id, sp: spCampaigns.length, sb: sbCampaigns.length, sd: sdCampaigns.length, total: all.length });
  return all;
}

async function syncCampaigns(profileDbRecord, amazonCampaigns) {
  const { id: profileDbId, workspace_id: workspaceId } = profileDbRecord;
  let upserted = 0;

  for (const c of amazonCampaigns) {
    await query(
      `INSERT INTO campaigns
         (workspace_id, profile_id, amazon_campaign_id, name, campaign_type,
          targeting_type, state, daily_budget, start_date, end_date,
          bidding_strategy, raw_data, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       ON CONFLICT (profile_id, amazon_campaign_id)
       DO UPDATE SET
         name = EXCLUDED.name,
         state = EXCLUDED.state,
         daily_budget = EXCLUDED.daily_budget,
         bidding_strategy = EXCLUDED.bidding_strategy,
         raw_data = EXCLUDED.raw_data,
         synced_at = NOW(),
         updated_at = NOW()`,
      [
        workspaceId, profileDbId,
        String(c.campaignId), c.name, c.campaignType,
        c.targetingType || null, (c.state || "ENABLED").toLowerCase(),
        c.dailyBudget ?? c.budget?.budget ?? null, c.startDate || null, c.endDate || null,
        c.bidding?.strategy || null, JSON.stringify(c),
      ]
    );
    upserted++;
  }

  await query(
    `INSERT INTO sync_state (profile_id, entity_type, last_full_sync, last_sync_status)
     VALUES ($1, 'campaigns', NOW(), 'synced')
     ON CONFLICT (profile_id, entity_type)
     DO UPDATE SET last_full_sync = NOW(), last_sync_status = 'synced', error_message = NULL`,
    [profileDbId]
  );

  logger.info("Campaigns synced", { profileDbId, count: upserted });
  return upserted;
}

// ─── AD GROUPS ────────────────────────────────────────────────────────────────

async function fetchAdGroups(profile, campaignType = "SP") {
  const { getValidAccessToken } = require("./lwa");
  const axios = require("axios");

  const COUNTRY_REGION = {
    US: "NA", CA: "NA", MX: "NA",
    GB: "EU", UK: "EU", DE: "EU", FR: "EU", IT: "EU", ES: "EU",
    NL: "EU", SE: "EU", PL: "EU", TR: "EU", SA: "EU", AE: "EU", BE: "EU",
    JP: "FE", AU: "FE", SG: "FE", IN: "FE",
  };
  const API_URLS = {
    NA: process.env.AMAZON_ADS_API_URL    || "https://advertising-api.amazon.com",
    EU: process.env.AMAZON_ADS_API_EU_URL || "https://advertising-api-eu.amazon.com",
    FE: process.env.AMAZON_ADS_API_FE_URL || "https://advertising-api-fe.amazon.com",
  };
  const resolvedRegion = COUNTRY_REGION[(profile.country_code || "").toUpperCase()] || "EU";
  const baseUrl = (API_URLS[resolvedRegion] || "https://advertising-api-eu.amazon.com").replace(/^http:\/\//i, "https://");
  const base = baseOpts(profile);

  if (campaignType === "SP") {
    const spAdGroups = [];
    try {
      const accessToken = await getValidAccessToken(profile.connection_id);
      const mediaType = "application/vnd.spAdGroup.v3+json";
      let nextToken = null;
      let page = 0;
      do {
        const body = {
          stateFilter: { include: ["ENABLED", "PAUSED", "ARCHIVED"] },
          maxResults: 100,
        };
        if (nextToken) body.nextToken = nextToken;

        const response = await axios.post(`${baseUrl}/sp/adGroups/list`, body, {
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Amazon-Advertising-API-ClientId": process.env.AMAZON_CLIENT_ID,
            "Amazon-Advertising-API-Scope": String(profile.profile_id),
            "Content-Type": mediaType,
            "Accept": mediaType,
          },
          timeout: 30000,
        });

        const data = response.data;
        const batch = Array.isArray(data.adGroups) ? data.adGroups : [];
        spAdGroups.push(...batch);
        nextToken = data.nextToken || null;
        page++;
        logger.info("SP adGroups list page", { profileId: profile.profile_id, page, count: batch.length, hasMore: !!nextToken });
      } while (nextToken && page < 400);

      logger.info("SP adGroups fetch complete", { profileId: profile.profile_id, total: spAdGroups.length });
    } catch (err) {
      logger.error("SP adGroups list failed", {
        profileId: profile.profile_id,
        status: err.response?.status,
        error: JSON.stringify(err.response?.data) || err.message,
      });
    }
    return spAdGroups;
  }

  // SB and SD — still GET-based
  const AD_GROUP_ENDPOINTS = { SB: "/sb/v4/adGroups", SD: "/sd/adGroups" };
  return getAll({
    ...base,
    path: AD_GROUP_ENDPOINTS[campaignType],
    params: { stateFilter: "enabled,paused,archived" },
    group: "ad_groups",
    responseKey: "adGroups",
  }).catch(err => {
    const status = err.status || err.response?.status;
    if ([401, 403, 404].includes(status)) {
      logger.info(`${campaignType} adGroups skipped`, { profileId: profile.profile_id, status });
      return [];
    }
    throw err;
  });
}

async function syncAdGroups(profileDbRecord, amazonAdGroups, campaignType) {
  const { id: profileDbId, workspace_id: workspaceId } = profileDbRecord;

  for (const ag of amazonAdGroups) {
    const { rows: [camp] } = await query(
      "SELECT id FROM campaigns WHERE profile_id = $1 AND amazon_campaign_id = $2",
      [profileDbId, String(ag.campaignId)]
    );
    if (!camp) continue;

    await query(
      `INSERT INTO ad_groups
         (workspace_id, profile_id, campaign_id, amazon_ag_id, name, state, default_bid, raw_data, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (profile_id, amazon_ag_id)
       DO UPDATE SET
         name = EXCLUDED.name, state = EXCLUDED.state,
         default_bid = EXCLUDED.default_bid, raw_data = EXCLUDED.raw_data,
         synced_at = NOW(), updated_at = NOW()`,
      [workspaceId, profileDbId, camp.id, String(ag.adGroupId), ag.name, (ag.state || "ENABLED").toLowerCase(), ag.defaultBid || null, JSON.stringify(ag)]
    );
  }

  logger.info("Ad groups synced", { profileDbId, count: amazonAdGroups.length });
}

// ─── KEYWORDS ────────────────────────────────────────────────────────────────

async function fetchKeywords(profile) {
  const { getValidAccessToken } = require("./lwa");
  const axios = require("axios");

  const COUNTRY_REGION = {
    US: "NA", CA: "NA", MX: "NA",
    GB: "EU", UK: "EU", DE: "EU", FR: "EU", IT: "EU", ES: "EU",
    NL: "EU", SE: "EU", PL: "EU", TR: "EU", SA: "EU", AE: "EU", BE: "EU",
    JP: "FE", AU: "FE", SG: "FE", IN: "FE",
  };
  const API_URLS = {
    NA: process.env.AMAZON_ADS_API_URL    || "https://advertising-api.amazon.com",
    EU: process.env.AMAZON_ADS_API_EU_URL || "https://advertising-api-eu.amazon.com",
    FE: process.env.AMAZON_ADS_API_FE_URL || "https://advertising-api-fe.amazon.com",
  };
  const resolvedRegion = COUNTRY_REGION[(profile.country_code || "").toUpperCase()] || "EU";
  const baseUrl = (API_URLS[resolvedRegion] || "https://advertising-api-eu.amazon.com").replace(/^http:\/\//i, "https://");

  const mediaType = "application/vnd.spKeyword.v3+json";

  // --- SP Keywords via POST /sp/keywords/list ---
  const spKeywords = [];
  try {
    const accessToken = await getValidAccessToken(profile.connection_id);
    let nextToken = null;
    let page = 0;
    do {
      const body = {
        stateFilter: { include: ["ENABLED", "PAUSED", "ARCHIVED"] },
        maxResults: 100,
      };
      if (nextToken) body.nextToken = nextToken;

      logger.info("SP keywords list request", {
        profileId: profile.profile_id,
        page,
        hasNextToken: !!nextToken,
        url: `${baseUrl}/sp/keywords/list`,
      });

      const response = await axios.post(
        `${baseUrl}/sp/keywords/list`,
        body,
        {
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Amazon-Advertising-API-ClientId": process.env.AMAZON_CLIENT_ID,
            "Amazon-Advertising-API-Scope": String(profile.profile_id),
            "Content-Type": mediaType,
            "Accept": mediaType,
          },
          timeout: 30000,
        }
      );

      const data = response.data;
      const batch = Array.isArray(data.keywords) ? data.keywords : [];
      spKeywords.push(...batch);
      nextToken = data.nextToken || null;
      page++;

      logger.info("SP keywords list page done", {
        profileId: profile.profile_id,
        page,
        batchCount: batch.length,
        totalSoFar: spKeywords.length,
        hasMore: !!nextToken,
        totalResults: data.totalResults,
      });
    } while (nextToken && page < 400); // safety cap: 10,000 keywords max

    logger.info("SP keywords fetch complete", {
      profileId: profile.profile_id,
      total: spKeywords.length,
    });
  } catch (err) {
    const status = err.response?.status;
    const errData = err.response?.data;
    logger.error("SP keywords list failed", {
      profileId: profile.profile_id,
      status,
      error: JSON.stringify(errData) || err.message,
    });
    // Don't throw — continue with 0 SP keywords, still try SB
  }

  // --- SB Keywords via getAll (SB v4 still uses GET + startIndex) ---
  const base = baseOpts(profile);
  let sbKeywords = [];
  try {
    sbKeywords = await getAll({
      ...base,
      path: "/sb/v4/keywords",
      params: { stateFilter: "enabled,paused,archived" },
      group: "keywords",
      responseKey: "keywords",
    });
    logger.info("SB keywords fetch complete", {
      profileId: profile.profile_id,
      total: sbKeywords.length,
    });
  } catch (err) {
    const status = err.status || err.response?.status;
    if ([401, 403, 404].includes(status)) {
      logger.info("SB keywords skipped (no access)", { profileId: profile.profile_id, status });
    } else {
      logger.warn("SB keywords failed", { profileId: profile.profile_id, error: err.message });
    }
  }

  return [...spKeywords, ...sbKeywords];
}

async function syncKeywords(profileDbRecord, amazonKeywords) {
  const { id: profileDbId, workspace_id: workspaceId } = profileDbRecord;
  let inserted = 0;

  for (const kw of amazonKeywords) {
    const { rows: [ag] } = await query(
      "SELECT id, campaign_id FROM ad_groups WHERE profile_id = $1 AND amazon_ag_id = $2",
      [profileDbId, String(kw.adGroupId)]
    );
    if (!ag) continue;

    await query(
      `INSERT INTO keywords
         (workspace_id, profile_id, ad_group_id, campaign_id, amazon_keyword_id,
          keyword_text, match_type, state, bid, raw_data, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (profile_id, amazon_keyword_id)
       DO UPDATE SET
         keyword_text = EXCLUDED.keyword_text, match_type = EXCLUDED.match_type,
         state = EXCLUDED.state, bid = EXCLUDED.bid, raw_data = EXCLUDED.raw_data,
         synced_at = NOW(), updated_at = NOW()`,
      [
        workspaceId, profileDbId, ag.id, ag.campaign_id,
        String(kw.keywordId), kw.keywordText, kw.matchType || "exact",
        (kw.state || "ENABLED").toLowerCase(), kw.bid || null, JSON.stringify(kw),
      ]
    );
    inserted++;
  }

  logger.info("Keywords synced", { profileDbId, count: inserted, fetched: amazonKeywords.length });
  return inserted;
}

// ─── PORTFOLIOS ──────────────────────────────────────────────────────────────

async function fetchPortfolios(profile) {
  const base = baseOpts(profile);
  const result = await getAll({
    ...base,
    path: "/portfolios",
    params: { portfolioStateFilter: "enabled,paused" },
    group: "default",
    responseKey: "portfolios",
    debug: true,
  });
  logger.info("fetchPortfolios result", { profileId: base.profileId, count: result.length });
  return result;
}

async function syncPortfolios(profileDbRecord, amazonPortfolios) {
  const { id: profileDbId, workspace_id: workspaceId } = profileDbRecord;

  for (const p of amazonPortfolios) {
    await query(
      `INSERT INTO portfolios
         (workspace_id, profile_id, amazon_portfolio_id, name, state,
          budget_amount, budget_currency, budget_start_date, budget_end_date, raw_data, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (profile_id, amazon_portfolio_id)
       DO UPDATE SET
         name = EXCLUDED.name, state = EXCLUDED.state,
         budget_amount = EXCLUDED.budget_amount,
         budget_currency = EXCLUDED.budget_currency,
         budget_start_date = EXCLUDED.budget_start_date,
         budget_end_date = EXCLUDED.budget_end_date,
         raw_data = EXCLUDED.raw_data,
         synced_at = NOW(), updated_at = NOW()`,
      [
        workspaceId, profileDbId,
        String(p.portfolioId), p.name, p.state || "enabled",
        p.budget?.amount || null, p.budget?.currencyCode || null,
        p.budget?.startDate || null, p.budget?.endDate || null,
        JSON.stringify(p),
      ]
    );
  }

  logger.info("Portfolios synced", { profileDbId, count: amazonPortfolios.length });
  return amazonPortfolios.length;
}

// ─── PRODUCT ADS ─────────────────────────────────────────────────────────────

async function fetchProductAds(profile) {
  const base = baseOpts(profile);
  return getAll({
    ...base,
    path: "/sp/productAds",
    params: { stateFilter: "enabled,paused,archived" },
    group: "ad_groups",
    responseKey: "productAds",
  });
}

async function syncProductAds(profileDbRecord, amazonProductAds) {
  const { id: profileDbId, workspace_id: workspaceId } = profileDbRecord;

  for (const ad of amazonProductAds) {
    // Resolve internal campaign/ad_group IDs
    const { rows: [camp] } = await query(
      "SELECT id FROM campaigns WHERE profile_id = $1 AND amazon_campaign_id = $2",
      [profileDbId, String(ad.campaignId)]
    );
    const { rows: [ag] } = await query(
      "SELECT id FROM ad_groups WHERE profile_id = $1 AND amazon_ag_id = $2",
      [profileDbId, String(ad.adGroupId)]
    );

    await query(
      `INSERT INTO product_ads
         (workspace_id, profile_id, campaign_id, ad_group_id, amazon_ad_id, asin, sku, state, raw_data, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (profile_id, amazon_ad_id)
       DO UPDATE SET
         asin = EXCLUDED.asin, sku = EXCLUDED.sku, state = EXCLUDED.state,
         raw_data = EXCLUDED.raw_data, synced_at = NOW(), updated_at = NOW()`,
      [
        workspaceId, profileDbId,
        camp?.id || null, ag?.id || null,
        String(ad.adId), ad.asin || null, ad.sku || null,
        ad.state || "enabled", JSON.stringify(ad),
      ]
    );
  }

  logger.info("Product ads synced", { profileDbId, count: amazonProductAds.length });
  return amazonProductAds.length;
}

// ─── TARGETS ─────────────────────────────────────────────────────────────────

const TARGET_ENDPOINTS = {
  SP: { path: "/sp/targets",  responseKey: "targetingClauses" },
  SD: { path: "/sd/targets",  responseKey: "targetingClauses" },
};

async function fetchTargets(profile, adType = "SP") {
  const base = baseOpts(profile);
  const ep = TARGET_ENDPOINTS[adType];
  return getAll({
    ...base,
    path: ep.path,
    params: { stateFilter: "enabled,paused,archived" },
    group: "ad_groups",
    responseKey: ep.responseKey,
  }).catch(err => {
    if (err.status === 401 || err.status === 403 || err.status === 404) {
      logger.info(`${adType} targets skipped`, { profileId: base.profileId, status: err.status });
      return [];
    }
    throw err;
  });
}

async function syncTargets(profileDbRecord, amazonTargets, adType = "SP") {
  const { id: profileDbId, workspace_id: workspaceId } = profileDbRecord;

  for (const t of amazonTargets) {
    const { rows: [camp] } = await query(
      "SELECT id FROM campaigns WHERE profile_id = $1 AND amazon_campaign_id = $2",
      [profileDbId, String(t.campaignId)]
    );
    const { rows: [ag] } = t.adGroupId ? await query(
      "SELECT id FROM ad_groups WHERE profile_id = $1 AND amazon_ag_id = $2",
      [profileDbId, String(t.adGroupId)]
    ) : { rows: [null] };

    await query(
      `INSERT INTO targets
         (workspace_id, profile_id, campaign_id, ad_group_id, amazon_target_id, ad_type,
          expression_type, expression, resolved_expression, state, bid, raw_data, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       ON CONFLICT (profile_id, amazon_target_id)
       DO UPDATE SET
         state = EXCLUDED.state, bid = EXCLUDED.bid,
         expression = EXCLUDED.expression,
         resolved_expression = EXCLUDED.resolved_expression,
         raw_data = EXCLUDED.raw_data, synced_at = NOW(), updated_at = NOW()`,
      [
        workspaceId, profileDbId,
        camp?.id || null, ag?.id || null,
        String(t.targetId), adType,
        t.expressionType || null,
        t.expression ? JSON.stringify(t.expression) : null,
        t.resolvedExpression ? JSON.stringify(t.resolvedExpression) : null,
        t.state || "enabled", t.bid || null,
        JSON.stringify(t),
      ]
    );
  }

  logger.info("Targets synced", { profileDbId, adType, count: amazonTargets.length });
  return amazonTargets.length;
}

// ─── NEGATIVE KEYWORDS ───────────────────────────────────────────────────────

async function fetchNegativeKeywords(profile) {
  const base = baseOpts(profile);

  const [adGroupLevel, campaignLevel] = await Promise.allSettled([
    // Ad-group level negative keywords
    getAll({ ...base, path: "/sp/negativeKeywords", params: { stateFilter: "enabled,archived" }, group: "keywords", responseKey: "negativeKeywords" })
      .then(r => r.map(kw => ({ ...kw, _level: "ad_group" }))),
    // Campaign level negative keywords
    getAll({ ...base, path: "/sp/campaignNegativeKeywords", params: { stateFilter: "enabled,archived" }, group: "keywords", responseKey: "negativeKeywords" })
      .then(r => r.map(kw => ({ ...kw, _level: "campaign" }))),
  ]);

  logger.info("fetchNegativeKeywords results", {
    profileId: base.profileId,
    adGroupLevel: adGroupLevel.status === "fulfilled" ? adGroupLevel.value.length : `ERROR: ${adGroupLevel.reason?.message}`,
    campaignLevel: campaignLevel.status === "fulfilled" ? campaignLevel.value.length : `ERROR: ${campaignLevel.reason?.message}`,
  });

  return [
    ...(adGroupLevel.status === "fulfilled" ? adGroupLevel.value : []),
    ...(campaignLevel.status === "fulfilled" ? campaignLevel.value : []),
  ];
}

async function syncNegativeKeywords(profileDbRecord, amazonNegKeywords) {
  const { id: profileDbId, workspace_id: workspaceId } = profileDbRecord;

  for (const kw of amazonNegKeywords) {
    const { rows: [camp] } = await query(
      "SELECT id FROM campaigns WHERE profile_id = $1 AND amazon_campaign_id = $2",
      [profileDbId, String(kw.campaignId)]
    );

    let agId = null;
    if (kw.adGroupId) {
      const { rows: [ag] } = await query(
        "SELECT id FROM ad_groups WHERE profile_id = $1 AND amazon_ag_id = $2",
        [profileDbId, String(kw.adGroupId)]
      );
      agId = ag?.id || null;
    }

    await query(
      `INSERT INTO negative_keywords
         (workspace_id, profile_id, campaign_id, ad_group_id, amazon_neg_keyword_id,
          keyword_text, match_type, level, raw_data, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (profile_id, amazon_neg_keyword_id)
       DO UPDATE SET
         keyword_text = EXCLUDED.keyword_text, match_type = EXCLUDED.match_type,
         raw_data = EXCLUDED.raw_data, synced_at = NOW(), updated_at = NOW()`,
      [
        workspaceId, profileDbId,
        camp?.id || null, agId,
        String(kw.keywordId), kw.keywordText, kw.matchType || "negativeExact",
        kw._level || "ad_group", JSON.stringify(kw),
      ]
    );
  }

  logger.info("Negative keywords synced", { profileDbId, count: amazonNegKeywords.length });
  return amazonNegKeywords.length;
}

// ─── NEGATIVE TARGETS ────────────────────────────────────────────────────────

const NEG_TARGET_ENDPOINTS = {
  SP: { path: "/sp/negativeTargets",  responseKey: "negativeTargetingClauses" },
  SD: { path: "/sd/negativeTargets",  responseKey: "negativeTargetingClauses" },
};

async function fetchNegativeTargets(profile, adType = "SP") {
  const base = baseOpts(profile);
  const ep = NEG_TARGET_ENDPOINTS[adType];
  return getAll({
    ...base,
    path: ep.path,
    params: { stateFilter: "enabled,archived" },
    group: "ad_groups",
    responseKey: ep.responseKey,
  }).catch(err => {
    if (err.status === 401 || err.status === 403 || err.status === 404) {
      logger.info(`${adType} negative targets skipped`, { profileId: base.profileId, status: err.status });
      return [];
    }
    throw err;
  });
}

async function syncNegativeTargets(profileDbRecord, amazonNegTargets, adType = "SP") {
  const { id: profileDbId, workspace_id: workspaceId } = profileDbRecord;

  for (const t of amazonNegTargets) {
    const { rows: [camp] } = await query(
      "SELECT id FROM campaigns WHERE profile_id = $1 AND amazon_campaign_id = $2",
      [profileDbId, String(t.campaignId)]
    );
    let agId = null;
    if (t.adGroupId) {
      const { rows: [ag] } = await query(
        "SELECT id FROM ad_groups WHERE profile_id = $1 AND amazon_ag_id = $2",
        [profileDbId, String(t.adGroupId)]
      );
      agId = ag?.id || null;
    }

    await query(
      `INSERT INTO negative_targets
         (workspace_id, profile_id, campaign_id, ad_group_id, amazon_neg_target_id, ad_type,
          expression, expression_type, level, raw_data, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (profile_id, amazon_neg_target_id)
       DO UPDATE SET
         expression = EXCLUDED.expression,
         expression_type = EXCLUDED.expression_type,
         raw_data = EXCLUDED.raw_data, synced_at = NOW(), updated_at = NOW()`,
      [
        workspaceId, profileDbId,
        camp?.id || null, agId,
        String(t.targetId), adType,
        t.expression ? JSON.stringify(t.expression) : null,
        t.expressionType || null,
        t.adGroupId ? "ad_group" : "campaign",
        JSON.stringify(t),
      ]
    );
  }

  logger.info("Negative targets synced", { profileDbId, adType, count: amazonNegTargets.length });
  return amazonNegTargets.length;
}

module.exports = {
  fetchProfiles,
  upsertProfiles,
  attachProfileToWorkspace,
  fetchCampaigns,
  syncCampaigns,
  fetchAdGroups,
  syncAdGroups,
  fetchKeywords,
  syncKeywords,
  fetchPortfolios,
  syncPortfolios,
  fetchProductAds,
  syncProductAds,
  fetchTargets,
  syncTargets,
  fetchNegativeKeywords,
  syncNegativeKeywords,
  fetchNegativeTargets,
  syncNegativeTargets,
};
