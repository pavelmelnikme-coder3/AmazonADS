/**
 * Amazon Ads Entity Services
 * Fetches and syncs: Profiles, Campaigns, Ad Groups, Keywords
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

/**
 * List all Amazon Ads profiles for a connection.
 * Tries the connection's stored region first, then falls back to all regions.
 */
async function fetchProfiles(connectionId) {
  const { rows: [conn] } = await query(
    "SELECT id, org_id, region FROM amazon_connections WHERE id = $1",
    [connectionId]
  );
  if (!conn) throw new Error("Connection not found");

  const { getValidAccessToken } = require("./lwa");
  const axios = require("axios");
  const accessToken = await getValidAccessToken(connectionId);

  // Try stored region first, then all others as fallback
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

  // Update region in DB if we found profiles in a different region
  if (successRegion && successRegion !== storedRegion) {
    await query("UPDATE amazon_connections SET region = $1 WHERE id = $2", [successRegion, connectionId]);
  }

  return allProfiles;
}

/**
 * Save profiles to DB after user selects which ones to attach.
 */
async function upsertProfiles(connectionId, profiles) {
  const { rows: [conn] } = await query(
    "SELECT org_id FROM amazon_connections WHERE id = $1",
    [connectionId]
  );

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

/**
 * Attach a profile to a workspace and queue initial sync.
 */
async function attachProfileToWorkspace(profileDbId, workspaceId) {
  await query(
    `UPDATE amazon_profiles
     SET workspace_id = $1, is_attached = TRUE, sync_status = 'pending', updated_at = NOW()
     WHERE id = $2`,
    [workspaceId, profileDbId]
  );
}

// ─── CAMPAIGNS ────────────────────────────────────────────────────────────────

const CAMPAIGN_ENDPOINTS = {
  SP: "/v2/sp/campaigns",
  SB: "/v2/sb/campaigns",
  SD: "/v2/sd/campaigns",
};

/**
 * Fetch all campaigns for a profile from Amazon.
 * Returns combined SP + SB + SD campaigns.
 */
async function fetchCampaigns(profile) {
  const { connection_id, profile_id, marketplace_id } = profile;
  const base = { connectionId: connection_id, profileId: String(profile_id), marketplace: marketplace_id };

  const results = await Promise.allSettled([
    getAll({ ...base, path: CAMPAIGN_ENDPOINTS.SP, params: { stateFilter: "enabled,paused,archived" }, group: "campaigns" })
      .then(r => r.map(c => ({ ...c, campaignType: "sponsoredProducts" }))),
    getAll({ ...base, path: CAMPAIGN_ENDPOINTS.SB, params: { stateFilter: "enabled,paused,archived" }, group: "campaigns" })
      .then(r => r.map(c => ({ ...c, campaignType: "sponsoredBrands" }))),
    getAll({ ...base, path: CAMPAIGN_ENDPOINTS.SD, params: { stateFilter: "enabled,paused,archived" }, group: "campaigns" })
      .then(r => r.map(c => ({ ...c, campaignType: "sponsoredDisplay" }))),
  ]);

  const campaigns = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      campaigns.push(...result.value);
    } else {
      logger.warn("Failed to fetch some campaign types", { error: result.reason?.message });
    }
  }

  return campaigns;
}

/**
 * Upsert campaigns into DB.
 */
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
        workspaceId,
        profileDbId,
        String(c.campaignId),
        c.name,
        c.campaignType,
        c.targetingType || null,
        c.state || "enabled",
        c.dailyBudget || null,
        c.startDate || null,
        c.endDate || null,
        c.bidding?.strategy || null,
        JSON.stringify(c),
      ]
    );
    upserted++;
  }

  // Update sync state
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

const AD_GROUP_ENDPOINTS = {
  SP: "/v2/sp/adGroups",
  SB: "/v2/sb/adGroups",
  SD: "/v2/sd/adGroups",
};

async function fetchAdGroups(profile, campaignType = "SP") {
  const { connection_id, profile_id, marketplace_id } = profile;
  return getAll({
    connectionId: connection_id,
    profileId: String(profile_id),
    marketplace: marketplace_id,
    path: AD_GROUP_ENDPOINTS[campaignType],
    params: { stateFilter: "enabled,paused,archived" },
    group: "ad_groups",
  });
}

async function syncAdGroups(profileDbRecord, amazonAdGroups, campaignType) {
  const { id: profileDbId, workspace_id: workspaceId } = profileDbRecord;

  for (const ag of amazonAdGroups) {
    // Get our internal campaign ID
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
      [workspaceId, profileDbId, camp.id, String(ag.adGroupId), ag.name, ag.state || "enabled", ag.defaultBid || null, JSON.stringify(ag)]
    );
  }

  logger.info("Ad groups synced", { profileDbId, count: amazonAdGroups.length });
}

// ─── KEYWORDS ────────────────────────────────────────────────────────────────

async function fetchKeywords(profile) {
  const { connection_id, profile_id, marketplace_id } = profile;
  const base = { connectionId: connection_id, profileId: String(profile_id), marketplace: marketplace_id };

  const [spKws, sbKws] = await Promise.allSettled([
    getAll({ ...base, path: "/v2/sp/keywords", params: { stateFilter: "enabled,paused,archived" }, group: "keywords" }),
    getAll({ ...base, path: "/v2/sb/keywords", params: { stateFilter: "enabled,paused,archived" }, group: "keywords" }),
  ]);

  return [
    ...(spKws.status === "fulfilled" ? spKws.value : []),
    ...(sbKws.status === "fulfilled" ? sbKws.value : []),
  ];
}

async function syncKeywords(profileDbRecord, amazonKeywords) {
  const { id: profileDbId, workspace_id: workspaceId } = profileDbRecord;

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
        kw.state || "enabled", kw.bid || null, JSON.stringify(kw),
      ]
    );
  }

  logger.info("Keywords synced", { profileDbId, count: amazonKeywords.length });
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
};
