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

const COUNTRY_REGION = {
  US: "NA", CA: "NA", MX: "NA",
  GB: "EU", UK: "EU", DE: "EU", FR: "EU", IT: "EU", ES: "EU",
  NL: "EU", SE: "EU", PL: "EU", TR: "EU", SA: "EU", AE: "EU", BE: "EU",
  JP: "FE", AU: "FE", SG: "FE", IN: "FE",
};

function resolveBaseUrl(profile) {
  const region = COUNTRY_REGION[(profile.country_code || "").toUpperCase()] || "EU";
  return (REGION_URLS[region] || "https://advertising-api-eu.amazon.com").replace(/^http:\/\//i, "https://");
}

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
    const values = [
      connectionId,
      p.profileId,
      p.marketplaceStringId || p.marketplace || (p.countryCode === "US" ? "ATVPDKIKX0DER" : ""),
      p.countryCode,
      p.countryCode,
      p.currencyCode || "USD",
      p.timezone || "UTC",
      p.accountInfo?.name || null,
      p.accountInfo?.type || null,
    ];

    // First try to update an existing profile with the same profile_id (any connection).
    // This handles re-connections: same Amazon profile, new connection → update connection_id
    // so the profile's campaigns/keywords data is preserved.
    const { rows: updated } = await query(
      `UPDATE amazon_profiles SET
         connection_id = $1,
         marketplace_id = $3,
         marketplace = $4,
         country_code = $5,
         currency_code = $6,
         timezone = $7,
         account_name = $8,
         account_type = $9,
         updated_at = NOW()
       WHERE profile_id = $2
       RETURNING *`,
      values
    );

    if (updated.length > 0) {
      saved.push(updated[0]);
      continue;
    }

    // No existing profile — insert fresh
    const { rows: inserted } = await query(
      `INSERT INTO amazon_profiles
         (connection_id, profile_id, marketplace_id, marketplace, country_code, currency_code,
          timezone, account_name, account_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (connection_id, profile_id) DO UPDATE SET
         marketplace_id = EXCLUDED.marketplace_id,
         marketplace = EXCLUDED.marketplace,
         country_code = EXCLUDED.country_code,
         currency_code = EXCLUDED.currency_code,
         timezone = EXCLUDED.timezone,
         account_name = EXCLUDED.account_name,
         account_type = EXCLUDED.account_type,
         updated_at = NOW()
       RETURNING *`,
      values
    );
    saved.push(inserted[0]);
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

  const baseUrl = resolveBaseUrl(profile);
  const base = baseOpts(profile);

  const [spResult, sbResult, sdResult] = await Promise.allSettled([
    // SP Campaigns via POST /sp/campaigns/list (parallel)
    (async () => {
      const accessToken = await getValidAccessToken(profile.connection_id);
      const mediaType = "application/vnd.spCampaign.v3+json";
      const campaigns = [];
      let nextToken = null;
      let page = 0;
      do {
        const body = {
          stateFilter: { include: ["ENABLED", "PAUSED", "ARCHIVED"] },
          maxResults: 500,
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
        campaigns.push(...batch);
        nextToken = data.nextToken || null;
        page++;
        logger.info("SP campaigns list page", { profileId: profile.profile_id, page, count: batch.length, hasMore: !!nextToken });
      } while (nextToken && page < 400);
      logger.info("SP campaigns fetch complete", { profileId: profile.profile_id, total: campaigns.length });
      return campaigns;
    })(),
    // SB Campaigns (GET-based, v4)
    getAll({ ...base, path: "/sb/v4/campaigns", params: { stateFilter: "enabled,paused,archived" }, group: "campaigns", responseKey: "campaigns" })
      .then(r => r.map(c => ({ ...c, campaignType: "sponsoredBrands" })))
      .catch(err => {
        logger.warn("SB campaigns failed", { profileId: profile.profile_id, error: err.message });
        return [];
      }),
    // SD Campaigns (GET-based)
    getAll({ ...base, path: "/sd/campaigns", params: { stateFilter: "enabled,paused,archived" }, group: "campaigns", responseKey: "campaigns" })
      .then(r => r.map(c => ({ ...c, campaignType: "sponsoredDisplay" })))
      .catch(err => {
        logger.warn("SD campaigns failed", { profileId: profile.profile_id, error: err.message });
        return [];
      }),
  ]);

  const spCampaigns = spResult.status === "fulfilled" ? spResult.value : [];
  const sbCampaigns = sbResult.status === "fulfilled" ? sbResult.value : [];
  const sdCampaigns = sdResult.status === "fulfilled" ? sdResult.value : [];

  const all = [...spCampaigns, ...sbCampaigns, ...sdCampaigns];
  logger.info("fetchCampaigns complete", { profileId: profile.profile_id, sp: spCampaigns.length, sb: sbCampaigns.length, sd: sdCampaigns.length, total: all.length });
  return all;
}

async function syncCampaigns(profileDbRecord, amazonCampaigns) {
  if (!amazonCampaigns.length) return 0;
  const { id: profileDbId, workspace_id: workspaceId } = profileDbRecord;
  const CHUNK = 500;
  let upserted = 0;

  for (let i = 0; i < amazonCampaigns.length; i += CHUNK) {
    const chunk = amazonCampaigns.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    let pi = 1;
    for (const c of chunk) {
      values.push(`($${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},NOW())`);
      params.push(
        workspaceId, profileDbId,
        String(c.campaignId), c.name, c.campaignType,
        c.targetingType || null,
        (c.state || "ENABLED").toLowerCase(),
        c.dailyBudget ?? c.budget?.budget ?? null,
        c.startDate || null, c.endDate || null,
        c.bidding?.strategy || null,
        JSON.stringify(c),
        c.portfolioId ? String(c.portfolioId) : null
      );
    }
    await query(
      `INSERT INTO campaigns
         (workspace_id, profile_id, amazon_campaign_id, name, campaign_type,
          targeting_type, state, daily_budget, start_date, end_date,
          bidding_strategy, raw_data, amazon_portfolio_id, synced_at)
       VALUES ${values.join(",")}
       ON CONFLICT (profile_id, amazon_campaign_id) DO UPDATE SET
         name=EXCLUDED.name, state=EXCLUDED.state,
         daily_budget=EXCLUDED.daily_budget,
         bidding_strategy=EXCLUDED.bidding_strategy,
         raw_data=EXCLUDED.raw_data,
         amazon_portfolio_id=EXCLUDED.amazon_portfolio_id,
         synced_at=NOW(), updated_at=NOW()`,
      params
    );
    upserted += chunk.length;
  }

  await query(
    `INSERT INTO sync_state (profile_id, entity_type, last_full_sync, last_sync_status)
     VALUES ($1, 'campaigns', NOW(), 'synced')
     ON CONFLICT (profile_id, entity_type)
     DO UPDATE SET last_full_sync = NOW(), last_sync_status = 'synced', error_message = NULL`,
    [profileDbId]
  );

  logger.info("Campaigns synced (batch)", { profileDbId, upserted });
  return upserted;
}

// ─── AD GROUPS ────────────────────────────────────────────────────────────────

async function fetchAdGroups(profile) {
  const { getValidAccessToken } = require("./lwa");
  const axios = require("axios");

  const baseUrl = resolveBaseUrl(profile);
  const base = baseOpts(profile);

  const [spResult, sbResult, sdResult] = await Promise.allSettled([
    // SP Ad Groups via POST /sp/adGroups/list
    (async () => {
      const accessToken = await getValidAccessToken(profile.connection_id);
      const mediaType = "application/vnd.spAdGroup.v3+json";
      const adGroups = [];
      let nextToken = null;
      let page = 0;
      do {
        const body = {
          stateFilter: { include: ["ENABLED", "PAUSED", "ARCHIVED"] },
          maxResults: 500,
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
        adGroups.push(...batch);
        nextToken = data.nextToken || null;
        page++;
        logger.info("SP adGroups list page", { profileId: profile.profile_id, page, count: batch.length, hasMore: !!nextToken });
      } while (nextToken && page < 400);
      logger.info("SP adGroups fetch complete", { profileId: profile.profile_id, total: adGroups.length });
      return adGroups;
    })(),
    // SB Ad Groups
    getAll({ ...base, path: "/sb/v4/adGroups", params: { stateFilter: "enabled,paused,archived" }, group: "ad_groups", responseKey: "adGroups" })
      .catch(err => {
        const status = err.status || err.response?.status;
        if ([401, 403, 404].includes(status)) logger.info("SB adGroups skipped", { profileId: profile.profile_id, status });
        else logger.warn("SB adGroups failed", { profileId: profile.profile_id, error: err.message });
        return [];
      }),
    // SD Ad Groups
    getAll({ ...base, path: "/sd/adGroups", params: { stateFilter: "enabled,paused,archived" }, group: "ad_groups", responseKey: "adGroups" })
      .catch(err => {
        const status = err.status || err.response?.status;
        if ([401, 403, 404].includes(status)) logger.info("SD adGroups skipped", { profileId: profile.profile_id, status });
        else logger.warn("SD adGroups failed", { profileId: profile.profile_id, error: err.message });
        return [];
      }),
  ]);

  const spAdGroups = spResult.status === "fulfilled" ? spResult.value : [];
  const sbAdGroups = sbResult.status === "fulfilled" ? sbResult.value : [];
  const sdAdGroups = sdResult.status === "fulfilled" ? sdResult.value : [];

  const all = [...spAdGroups, ...sbAdGroups, ...sdAdGroups];
  logger.info("fetchAdGroups complete", { profileId: profile.profile_id, sp: spAdGroups.length, sb: sbAdGroups.length, sd: sdAdGroups.length, total: all.length });
  return all;
}

async function syncAdGroups(profileDbRecord, amazonAdGroups) {
  if (!amazonAdGroups.length) return 0;
  const { id: profileDbId, workspace_id: workspaceId } = profileDbRecord;

  // Pre-load campaign id map once
  const { rows: campRows } = await query(
    "SELECT id, amazon_campaign_id FROM campaigns WHERE profile_id = $1",
    [profileDbId]
  );
  const campMap = new Map(campRows.map(r => [r.amazon_campaign_id, r.id]));

  const CHUNK = 500;
  let upserted = 0;

  for (let i = 0; i < amazonAdGroups.length; i += CHUNK) {
    const chunk = amazonAdGroups.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    let pi = 1;
    for (const ag of chunk) {
      const campaignDbId = campMap.get(String(ag.campaignId));
      if (!campaignDbId) continue;
      values.push(`($${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},NOW())`);
      params.push(
        workspaceId, profileDbId, campaignDbId,
        String(ag.adGroupId), ag.name,
        (ag.state || "ENABLED").toLowerCase(),
        ag.defaultBid || null,
        JSON.stringify(ag)
      );
    }
    if (!values.length) continue;
    await query(
      `INSERT INTO ad_groups
         (workspace_id, profile_id, campaign_id, amazon_ag_id, name, state, default_bid, raw_data, synced_at)
       VALUES ${values.join(",")}
       ON CONFLICT (profile_id, amazon_ag_id) DO UPDATE SET
         name=EXCLUDED.name, state=EXCLUDED.state,
         default_bid=EXCLUDED.default_bid, raw_data=EXCLUDED.raw_data,
         synced_at=NOW(), updated_at=NOW()`,
      params
    );
    upserted += values.length;
  }

  logger.info("AdGroups synced (batch)", { profileDbId, upserted });
  return upserted;
}

// ─── KEYWORDS ────────────────────────────────────────────────────────────────

async function fetchKeywords(profile) {
  const { getValidAccessToken } = require("./lwa");
  const axios = require("axios");

  const baseUrl = resolveBaseUrl(profile);
  const base = baseOpts(profile);
  const mediaType = "application/vnd.spKeyword.v3+json";

  const [spResult, sbResult] = await Promise.allSettled([
    // SP Keywords via POST /sp/keywords/list
    (async () => {
      const accessToken = await getValidAccessToken(profile.connection_id);
      const keywords = [];
      let nextToken = null;
      let page = 0;
      do {
        const body = {
          stateFilter: { include: ["ENABLED", "PAUSED", "ARCHIVED"] },
          maxResults: 500,
        };
        if (nextToken) body.nextToken = nextToken;
        logger.info("SP keywords list request", {
          profileId: profile.profile_id,
          page,
          hasNextToken: !!nextToken,
          url: `${baseUrl}/sp/keywords/list`,
        });
        const response = await axios.post(`${baseUrl}/sp/keywords/list`, body, {
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
        const batch = Array.isArray(data.keywords) ? data.keywords : [];
        keywords.push(...batch);
        nextToken = data.nextToken || null;
        page++;
        logger.info("SP keywords list page done", {
          profileId: profile.profile_id,
          page,
          batchCount: batch.length,
          totalSoFar: keywords.length,
          hasMore: !!nextToken,
          totalResults: data.totalResults,
        });
      } while (nextToken && page < 400);
      logger.info("SP keywords fetch complete", { profileId: profile.profile_id, total: keywords.length });
      return keywords;
    })(),
    // SB Keywords via getAll (SB v4 still uses GET + startIndex)
    getAll({ ...base, path: "/sb/v4/keywords", params: { stateFilter: "enabled,paused,archived" }, group: "keywords", responseKey: "keywords" })
      .catch(err => {
        const status = err.status || err.response?.status;
        if ([401, 403, 404].includes(status)) {
          logger.info("SB keywords skipped (no access)", { profileId: profile.profile_id, status });
        } else {
          logger.warn("SB keywords failed", { profileId: profile.profile_id, error: err.message });
        }
        return [];
      }),
  ]);

  const spKeywords = spResult.status === "fulfilled" ? spResult.value : [];
  const sbKeywords = sbResult.status === "fulfilled" ? sbResult.value : [];

  logger.info("fetchKeywords complete", { profileId: profile.profile_id, sp: spKeywords.length, sb: sbKeywords.length });
  return [...spKeywords, ...sbKeywords];
}

async function syncKeywords(profileDbRecord, amazonKeywords) {
  if (!amazonKeywords.length) return 0;
  const { id: profileDbId, workspace_id: workspaceId } = profileDbRecord;

  // Pre-load ad_group map once (1 query instead of N roundtrips)
  const { rows: agRows } = await query(
    "SELECT id, campaign_id, amazon_ag_id FROM ad_groups WHERE profile_id = $1",
    [profileDbId]
  );
  const agMap = new Map(agRows.map(r => [r.amazon_ag_id, { id: r.id, campaign_id: r.campaign_id }]));

  const CHUNK = 500;
  let inserted = 0;

  for (let i = 0; i < amazonKeywords.length; i += CHUNK) {
    const chunk = amazonKeywords.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    let pi = 1;
    for (const kw of chunk) {
      const ag = agMap.get(String(kw.adGroupId));
      if (!ag) continue;
      values.push(`($${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},NOW())`);
      params.push(
        workspaceId, profileDbId, ag.id, ag.campaign_id,
        String(kw.keywordId), kw.keywordText,
        (kw.matchType || "EXACT").toLowerCase(),
        (kw.state || "ENABLED").toLowerCase(),
        kw.bid || null,
        JSON.stringify(kw)
      );
    }
    if (!values.length) continue;
    await query(
      `INSERT INTO keywords
         (workspace_id, profile_id, ad_group_id, campaign_id, amazon_keyword_id,
          keyword_text, match_type, state, bid, raw_data, synced_at)
       VALUES ${values.join(",")}
       ON CONFLICT (profile_id, amazon_keyword_id) DO UPDATE SET
         keyword_text=EXCLUDED.keyword_text, match_type=EXCLUDED.match_type,
         state=EXCLUDED.state, bid=EXCLUDED.bid, raw_data=EXCLUDED.raw_data,
         synced_at=NOW(), updated_at=NOW()`,
      params
    );
    inserted += values.length;
  }

  logger.info("Keywords synced (batch)", { profileDbId, inserted, fetched: amazonKeywords.length });
  return inserted;
}

// ─── PORTFOLIOS ──────────────────────────────────────────────────────────────

async function fetchPortfolios(profile) {
  const { getValidAccessToken } = require("./lwa");
  const axios = require("axios");

  const baseUrl = resolveBaseUrl(profile);
  const accessToken = await getValidAccessToken(profile.connection_id);
  const mediaType = "application/vnd.portfolio.v3+json";

  const headers = {
    "Authorization": `Bearer ${accessToken}`,
    "Amazon-Advertising-API-ClientId": process.env.AMAZON_CLIENT_ID,
    "Amazon-Advertising-API-Scope": String(profile.profile_id),
    "Content-Type": mediaType,
    "Accept": mediaType,
  };

  async function fetchByState(state) {
    const items = [];
    let nextToken = null;
    do {
      const body = { stateFilter: { include: [state] }, maxResults: 100 };
      if (nextToken) body.nextToken = nextToken;
      const response = await axios.post(`${baseUrl}/portfolios/list`, body, {
        headers, timeout: 30000, validateStatus: null,
      });
      if (response.status === 200) {
        items.push(...(response.data?.portfolios || []));
        nextToken = response.data?.nextToken || null;
      } else {
        logger.warn("fetchPortfolios v3 failed", {
          profileId: profile.profile_id, state, status: response.status,
          body: JSON.stringify(response.data).slice(0, 300),
        });
        break;
      }
    } while (nextToken);
    return items;
  }

  const portfolios = [];
  try {
    // API v3 only supports ENABLED state filter for portfolios
    const enabled = await fetchByState("ENABLED");
    portfolios.push(...enabled);
  } catch (e) {
    logger.warn("fetchPortfolios error", { profileId: profile.profile_id, error: e.message });
  }

  logger.info("fetchPortfolios result", { profileId: profile.profile_id, count: portfolios.length });
  return portfolios;
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
        String(p.portfolioId), p.name, (p.state || "ENABLED").toLowerCase(),
        p.budget?.amount || null, p.budget?.currencyCode || null,
        null, p.budget?.endDate || null,
        JSON.stringify(p),
      ]
    );
  }

  logger.info("Portfolios synced", { profileDbId, count: amazonPortfolios.length });
  return amazonPortfolios.length;
}

// ─── PRODUCT ADS ─────────────────────────────────────────────────────────────

// Sponsored Products product ads via v3 (POST /sp/productAds/list).
// Legacy GET /sp/productAds returns 403 in the EU region — same v2 deprecation
// as targets/keywords. v3 uses the standard list-with-stateFilter pattern.
async function fetchProductAds(profile) {
  const { getValidAccessToken } = require("./lwa");
  const axios = require("axios");

  const baseUrl = resolveBaseUrl(profile);
  const mediaType = "application/vnd.spProductAd.v3+json";

  try {
    const accessToken = await getValidAccessToken(profile.connection_id);
    const ads = [];
    let nextToken = null;
    let page = 0;
    do {
      const body = {
        stateFilter: { include: ["ENABLED", "PAUSED", "ARCHIVED"] },
        maxResults: 500,
      };
      if (nextToken) body.nextToken = nextToken;
      const response = await axios.post(`${baseUrl}/sp/productAds/list`, body, {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Amazon-Advertising-API-ClientId": process.env.AMAZON_CLIENT_ID,
          "Amazon-Advertising-API-Scope": String(profile.profile_id),
          "Content-Type": mediaType,
          "Accept": mediaType,
        },
        timeout: 30000,
      });
      const batch = Array.isArray(response.data?.productAds) ? response.data.productAds : [];
      ads.push(...batch);
      nextToken = response.data?.nextToken || null;
      page++;
      logger.info("SP productAds list page done", {
        profileId: profile.profile_id, page,
        batchCount: batch.length, totalSoFar: ads.length, hasMore: !!nextToken,
        totalResults: response.data?.totalResults,
      });
    } while (nextToken && page < 400);
    logger.info("SP productAds fetch complete",
      { profileId: profile.profile_id, total: ads.length });
    return ads;
  } catch (err) {
    const status = err.response?.status || err.status;
    if ([401, 403, 404].includes(status)) {
      logger.info("SP productAds skipped (no access)",
        { profileId: profile.profile_id, status });
      return [];
    }
    logger.warn("SP productAds fetch failed",
      { profileId: profile.profile_id, status, error: err.message,
        responseBody: err.response?.data });
    return [];
  }
}

async function syncProductAds(profileDbRecord, amazonProductAds) {
  if (!amazonProductAds.length) return 0;
  const { id: profileDbId, workspace_id: workspaceId } = profileDbRecord;

  // Pre-load campaign and ad_group maps
  const { rows: campRows } = await query(
    "SELECT id, amazon_campaign_id FROM campaigns WHERE profile_id = $1",
    [profileDbId]
  );
  const campMap = new Map(campRows.map(r => [r.amazon_campaign_id, r.id]));

  const { rows: agRows } = await query(
    "SELECT id, amazon_ag_id FROM ad_groups WHERE profile_id = $1",
    [profileDbId]
  );
  const agMap = new Map(agRows.map(r => [r.amazon_ag_id, r.id]));

  const CHUNK = 500;
  let upserted = 0;

  for (let i = 0; i < amazonProductAds.length; i += CHUNK) {
    const chunk = amazonProductAds.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    let pi = 1;
    for (const ad of chunk) {
      // v3 returns state UPPERCASE — normalize to lowercase to match schema.
      values.push(`($${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},NOW())`);
      params.push(
        workspaceId, profileDbId,
        campMap.get(String(ad.campaignId)) || null,
        agMap.get(String(ad.adGroupId)) || null,
        String(ad.adId), ad.asin || null, ad.sku || null,
        (ad.state || "enabled").toLowerCase(), JSON.stringify(ad),
      );
    }
    await query(
      `INSERT INTO product_ads
         (workspace_id, profile_id, campaign_id, ad_group_id, amazon_ad_id, asin, sku, state, raw_data, synced_at)
       VALUES ${values.join(",")}
       ON CONFLICT (profile_id, amazon_ad_id) DO UPDATE SET
         asin=EXCLUDED.asin, sku=EXCLUDED.sku, state=EXCLUDED.state,
         raw_data=EXCLUDED.raw_data, synced_at=NOW(), updated_at=NOW()`,
      params
    );
    upserted += chunk.length;
  }

  logger.info("Product ads synced (batch)", { profileDbId, upserted });
  return upserted;
}

// ─── TARGETS ─────────────────────────────────────────────────────────────────

// Targeting clauses:
//   SP — Amazon Ads API v3 (POST /sp/targets/list). Required for AUTO targeting
//        expressions (close/loose match, substitutes, complements) — the legacy
//        GET endpoint omits them, which is why ~98% of AUTO campaigns had no
//        targets in our DB.
//   SD — legacy GET /sd/targets. Amazon hasn't released a v3 list for SD; the
//        v3 POST returns 405 Method Not Allowed in EU region.
async function fetchTargets(profile, adType = "SP") {
  if (adType === "SD") {
    const base = baseOpts(profile);
    return getAll({
      ...base,
      path: "/sd/targets",
      params: { stateFilter: "enabled,paused,archived" },
      group: "ad_groups",
      responseKey: null,
    }).catch(err => {
      if (err.status === 401 || err.status === 403 || err.status === 404) {
        logger.info("SD targets skipped (no access)",
          { profileId: profile.profile_id, status: err.status });
        return [];
      }
      throw err;
    });
  }

  const { getValidAccessToken } = require("./lwa");
  const axios = require("axios");

  const baseUrl = resolveBaseUrl(profile);
  const mediaType = "application/vnd.spTargetingClause.v3+json";

  try {
    const accessToken = await getValidAccessToken(profile.connection_id);
    const targets = [];
    let nextToken = null;
    let page = 0;
    do {
      const body = {
        stateFilter: { include: ["ENABLED", "PAUSED", "ARCHIVED"] },
        maxResults: 500,
      };
      if (nextToken) body.nextToken = nextToken;
      const response = await axios.post(`${baseUrl}/sp/targets/list`, body, {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Amazon-Advertising-API-ClientId": process.env.AMAZON_CLIENT_ID,
          "Amazon-Advertising-API-Scope": String(profile.profile_id),
          "Content-Type": mediaType,
          "Accept": mediaType,
        },
        timeout: 30000,
      });
      const batch = Array.isArray(response.data?.targetingClauses)
        ? response.data.targetingClauses : [];
      targets.push(...batch);
      nextToken = response.data?.nextToken || null;
      page++;
      logger.info("SP targets list page done", {
        profileId: profile.profile_id, page,
        batchCount: batch.length, totalSoFar: targets.length, hasMore: !!nextToken,
        totalResults: response.data?.totalResults,
      });
    } while (nextToken && page < 400);
    logger.info("SP targets fetch complete",
      { profileId: profile.profile_id, total: targets.length });
    return targets;
  } catch (err) {
    const status = err.response?.status || err.status;
    if ([401, 403, 404].includes(status)) {
      logger.info("SP targets skipped (no access)",
        { profileId: profile.profile_id, status });
      return [];
    }
    logger.warn("SP targets fetch failed",
      { profileId: profile.profile_id, status, error: err.message,
        responseBody: err.response?.data });
    return [];
  }
}

async function syncTargets(profileDbRecord, amazonTargets, adType = "SP") {
  if (!amazonTargets.length) return 0;
  const { id: profileDbId, workspace_id: workspaceId } = profileDbRecord;

  // Pre-load campaign and ad_group maps
  const { rows: campRows } = await query(
    "SELECT id, amazon_campaign_id FROM campaigns WHERE profile_id = $1",
    [profileDbId]
  );
  const campMap = new Map(campRows.map(r => [r.amazon_campaign_id, r.id]));

  const { rows: agRows } = await query(
    "SELECT id, amazon_ag_id FROM ad_groups WHERE profile_id = $1",
    [profileDbId]
  );
  const agMap = new Map(agRows.map(r => [r.amazon_ag_id, r.id]));

  const CHUNK = 500;
  let upserted = 0;

  for (let i = 0; i < amazonTargets.length; i += CHUNK) {
    const chunk = amazonTargets.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    let pi = 1;
    for (const t of chunk) {
      // v3 returns state as UPPERCASE ("ENABLED"/"PAUSED"/"ARCHIVED") and bid
      // can come as a plain number or as { value, currency }. Normalize both
      // to match the schema (lowercase state, NUMERIC bid).
      const stateLower = (t.state || "enabled").toLowerCase();
      const bidValue = (t.bid && typeof t.bid === "object")
        ? (Number(t.bid.value) || null)
        : (t.bid != null ? Number(t.bid) : null);
      values.push(`($${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},NOW())`);
      params.push(
        workspaceId, profileDbId,
        campMap.get(String(t.campaignId)) || null,
        t.adGroupId ? (agMap.get(String(t.adGroupId)) || null) : null,
        String(t.targetId), adType,
        t.expressionType || null,
        t.expression ? JSON.stringify(t.expression) : null,
        t.resolvedExpression ? JSON.stringify(t.resolvedExpression) : null,
        stateLower, bidValue,
        JSON.stringify(t),
      );
    }
    if (!values.length) continue;
    await query(
      `INSERT INTO targets
         (workspace_id, profile_id, campaign_id, ad_group_id, amazon_target_id, ad_type,
          expression_type, expression, resolved_expression, state, bid, raw_data, synced_at)
       VALUES ${values.join(",")}
       ON CONFLICT (profile_id, amazon_target_id) DO UPDATE SET
         state=EXCLUDED.state, bid=EXCLUDED.bid,
         expression=EXCLUDED.expression,
         resolved_expression=EXCLUDED.resolved_expression,
         raw_data=EXCLUDED.raw_data, synced_at=NOW(), updated_at=NOW()`,
      params
    );
    upserted += values.length;
  }

  logger.info("Targets synced (batch)", { profileDbId, adType, upserted });
  return upserted;
}

// ─── NEGATIVE KEYWORDS ───────────────────────────────────────────────────────

async function fetchNegativeKeywords(profile) {
  const { getValidAccessToken } = require("./lwa");
  const axios = require("axios");

  const baseUrl = resolveBaseUrl(profile);

  const spNegKws = [];
  try {
    const accessToken = await getValidAccessToken(profile.connection_id);
    const mediaType = "application/vnd.spNegativeKeyword.v3+json";
    let nextToken = null;
    let page = 0;
    do {
      const body = {
        stateFilter: { include: ["ENABLED", "ARCHIVED"] },
        maxResults: 500,
      };
      if (nextToken) body.nextToken = nextToken;

      const response = await axios.post(`${baseUrl}/sp/negativeKeywords/list`, body, {
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
      const batch = Array.isArray(data.negativeKeywords) ? data.negativeKeywords : [];
      spNegKws.push(...batch);
      nextToken = data.nextToken || null;
      page++;
    } while (nextToken && page < 400);

    logger.info("SP negativeKeywords fetch complete", { profileId: profile.profile_id, total: spNegKws.length });
  } catch (err) {
    logger.error("SP negativeKeywords list failed", {
      profileId: profile.profile_id,
      status: err.response?.status,
      error: JSON.stringify(err.response?.data) || err.message,
    });
  }
  return spNegKws;
}

async function syncNegativeKeywords(profileDbRecord, amazonNegKeywords) {
  if (!amazonNegKeywords.length) return 0;
  const { id: profileDbId, workspace_id: workspaceId } = profileDbRecord;

  // Pre-load ad_group and campaign maps
  const { rows: agRows } = await query(
    "SELECT id, campaign_id, amazon_ag_id FROM ad_groups WHERE profile_id = $1",
    [profileDbId]
  );
  const agMap = new Map(agRows.map(r => [r.amazon_ag_id, { id: r.id, campaign_id: r.campaign_id }]));

  const { rows: campRows } = await query(
    "SELECT id, amazon_campaign_id FROM campaigns WHERE profile_id = $1",
    [profileDbId]
  );
  const campMap = new Map(campRows.map(r => [r.amazon_campaign_id, r.id]));

  const CHUNK = 500;
  let upserted = 0;

  for (let i = 0; i < amazonNegKeywords.length; i += CHUNK) {
    const chunk = amazonNegKeywords.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    let pi = 1;
    for (const kw of chunk) {
      let campId = null;
      let agId = null;

      if (kw.adGroupId) {
        const ag = agMap.get(String(kw.adGroupId));
        if (ag) { agId = ag.id; campId = ag.campaign_id; }
      }
      if (!campId && kw.campaignId) {
        campId = campMap.get(String(kw.campaignId)) || null;
      }

      values.push(`($${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},NOW())`);
      params.push(
        workspaceId, profileDbId, campId, agId,
        String(kw.keywordId), kw.keywordText,
        (kw.matchType || "NEGATIVE_EXACT").toLowerCase(),
        agId ? "ad_group" : "campaign",
        JSON.stringify(kw),
      );
    }
    if (!values.length) continue;
    await query(
      `INSERT INTO negative_keywords
         (workspace_id, profile_id, campaign_id, ad_group_id, amazon_neg_keyword_id,
          keyword_text, match_type, level, raw_data, synced_at)
       VALUES ${values.join(",")}
       ON CONFLICT (profile_id, amazon_neg_keyword_id) DO UPDATE SET
         keyword_text=EXCLUDED.keyword_text, match_type=EXCLUDED.match_type,
         raw_data=EXCLUDED.raw_data, synced_at=NOW(), updated_at=NOW()`,
      params
    );
    upserted += values.length;
  }

  logger.info("Negative keywords synced (batch)", { profileDbId, upserted });
  return upserted;
}

// ─── NEGATIVE TARGETS ────────────────────────────────────────────────────────

// Negative targets:
//   SP — Amazon Ads API v3 (POST /sp/negativeTargets/list).
//   SD — legacy GET /sd/negativeTargets (no v3 list endpoint exists yet).
async function fetchNegativeTargets(profile, adType = "SP") {
  if (adType === "SD") {
    const base = baseOpts(profile);
    return getAll({
      ...base,
      path: "/sd/negativeTargets",
      params: { stateFilter: "enabled,archived" },
      group: "ad_groups",
      responseKey: null,
    }).catch(err => {
      if (err.status === 401 || err.status === 403 || err.status === 404) {
        logger.info("SD negative targets skipped (no access)",
          { profileId: profile.profile_id, status: err.status });
        return [];
      }
      throw err;
    });
  }

  const { getValidAccessToken } = require("./lwa");
  const axios = require("axios");

  const baseUrl = resolveBaseUrl(profile);
  const mediaType = "application/vnd.spNegativeTargetingClause.v3+json";

  try {
    const accessToken = await getValidAccessToken(profile.connection_id);
    const negTargets = [];
    let nextToken = null;
    let page = 0;
    do {
      const body = {
        stateFilter: { include: ["ENABLED", "ARCHIVED"] },
        maxResults: 500,
      };
      if (nextToken) body.nextToken = nextToken;
      const response = await axios.post(`${baseUrl}/sp/negativeTargets/list`, body, {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Amazon-Advertising-API-ClientId": process.env.AMAZON_CLIENT_ID,
          "Amazon-Advertising-API-Scope": String(profile.profile_id),
          "Content-Type": mediaType,
          "Accept": mediaType,
        },
        timeout: 30000,
      });
      const batch = Array.isArray(response.data?.negativeTargetingClauses)
        ? response.data.negativeTargetingClauses : [];
      negTargets.push(...batch);
      nextToken = response.data?.nextToken || null;
      page++;
      logger.info("SP negativeTargets list page done", {
        profileId: profile.profile_id, page,
        batchCount: batch.length, totalSoFar: negTargets.length, hasMore: !!nextToken,
        totalResults: response.data?.totalResults,
      });
    } while (nextToken && page < 400);
    logger.info("SP negativeTargets fetch complete",
      { profileId: profile.profile_id, total: negTargets.length });
    return negTargets;
  } catch (err) {
    const status = err.response?.status || err.status;
    if ([401, 403, 404].includes(status)) {
      logger.info("SP negative targets skipped (no access)",
        { profileId: profile.profile_id, status });
      return [];
    }
    logger.warn("SP negativeTargets fetch failed",
      { profileId: profile.profile_id, status, error: err.message,
        responseBody: err.response?.data });
    return [];
  }
}

async function syncNegativeTargets(profileDbRecord, amazonNegTargets, adType = "SP") {
  if (!amazonNegTargets.length) return 0;
  const { id: profileDbId, workspace_id: workspaceId } = profileDbRecord;

  // Pre-load campaign and ad_group maps
  const { rows: campRows } = await query(
    "SELECT id, amazon_campaign_id FROM campaigns WHERE profile_id = $1",
    [profileDbId]
  );
  const campMap = new Map(campRows.map(r => [r.amazon_campaign_id, r.id]));

  const { rows: agRows } = await query(
    "SELECT id, amazon_ag_id FROM ad_groups WHERE profile_id = $1",
    [profileDbId]
  );
  const agMap = new Map(agRows.map(r => [r.amazon_ag_id, r.id]));

  const CHUNK = 500;
  let upserted = 0;

  for (let i = 0; i < amazonNegTargets.length; i += CHUNK) {
    const chunk = amazonNegTargets.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    let pi = 1;
    for (const t of chunk) {
      values.push(`($${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},$${pi++},NOW())`);
      params.push(
        workspaceId, profileDbId,
        campMap.get(String(t.campaignId)) || null,
        t.adGroupId ? (agMap.get(String(t.adGroupId)) || null) : null,
        String(t.targetId), adType,
        t.expression ? JSON.stringify(t.expression) : null,
        t.expressionType || null,
        t.adGroupId ? "ad_group" : "campaign",
        JSON.stringify(t),
      );
    }
    if (!values.length) continue;
    await query(
      `INSERT INTO negative_targets
         (workspace_id, profile_id, campaign_id, ad_group_id, amazon_neg_target_id, ad_type,
          expression, expression_type, level, raw_data, synced_at)
       VALUES ${values.join(",")}
       ON CONFLICT (profile_id, amazon_neg_target_id) DO UPDATE SET
         expression=EXCLUDED.expression,
         expression_type=EXCLUDED.expression_type,
         raw_data=EXCLUDED.raw_data, synced_at=NOW(), updated_at=NOW()`,
      params
    );
    upserted += values.length;
  }

  logger.info("Negative targets synced (batch)", { profileDbId, adType, upserted });
  return upserted;
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
