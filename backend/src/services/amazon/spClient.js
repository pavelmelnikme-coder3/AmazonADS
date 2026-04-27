const axios = require("axios");
const logger = require("../../config/logger");

const SP_API_URLS = {
  NA: process.env.SP_API_URL_NA || "https://sellingpartnerapi-na.amazon.com",
  EU: process.env.SP_API_URL_EU || "https://sellingpartnerapi-eu.amazon.com",
  FE: process.env.SP_API_URL_FE || "https://sellingpartnerapi-fe.amazon.com",
};

const MARKETPLACE_REGION = {
  ATVPDKIKX0DER: "NA", A2EUQ1WTGCTBG2: "NA", A1AM78C64UM0Y8: "NA",
  A1F83G8C2ARO7P: "EU", A1PA6795UKMFR9: "EU", APJ6JRA9NG5V4: "EU",
  A13V1IB3VIYZZH: "EU", A1RKKUPIHCS9HS: "EU", A1805IZSGTT6HW: "EU",
  A39IBJ37TRP1C6: "FE", A1VC38T7YXB528: "FE", A21TJRUUN4KGV: "FE",
};

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const tokenCache = new Map();

async function getSpAccessToken(refreshToken) {
  const cacheKey = refreshToken.slice(0, 20);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.accessToken;

  const response = await axios.post(LWA_TOKEN_URL, new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: process.env.SP_API_CLIENT_ID,
    client_secret: process.env.SP_API_CLIENT_SECRET,
  }), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });

  const { access_token, expires_in } = response.data;
  tokenCache.set(cacheKey, { accessToken: access_token, expiresAt: Date.now() + (expires_in - 60) * 1000 });
  return access_token;
}

async function _spRequest(region, path, params, refreshToken, attempt = 1) {
  const baseUrl = SP_API_URLS[region] || SP_API_URLS.EU;
  const token = await getSpAccessToken(refreshToken);
  try {
    const res = await axios.get(`${baseUrl}${path}`, {
      params,
      headers: {
        "x-amz-access-token": token,
        "x-amzn-requestid": `adsflow-${Date.now()}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    });
    return res.data;
  } catch (err) {
    const spCode = err.response?.data?.errors?.[0]?.code;
    const spMsg  = err.response?.data?.errors?.[0]?.message;
    const status = err.response?.status;
    if (status === 429) {
      const retryAfter = parseInt(err.response.headers?.["retry-after"] || "60", 10);
      // Retry on rate limit up to 3 times with the Retry-After hint, capped
      // at 90s so a single sync doesn't block forever. Beyond that, surface
      // the error so the caller can record it in sp_sync_log.
      if (attempt <= 3) {
        const waitMs = Math.min(retryAfter, 90) * 1000;
        logger.warn("SP-API rate limited — retrying", { path, attempt, waitMs });
        await _sleep(waitMs);
        return _spRequest(region, path, params, refreshToken, attempt + 1);
      }
      const e = new Error(`SP-API rate limit: ${path}`);
      e.retryAfter = retryAfter;
      throw e;
    }
    throw new Error(`SP-API ${status} ${spCode || ""}: ${spMsg || err.message}`);
  }
}

// ─── Catalog Items (BSR + metadata) ──────────────────────────────────────────
async function getCatalogItem(asin, marketplaceId, refreshToken) {
  const token = refreshToken || process.env.SP_API_REFRESH_TOKEN;
  if (!token) throw new Error("SP_API_REFRESH_TOKEN not configured");
  const region = MARKETPLACE_REGION[marketplaceId] || "EU";
  const data = await _spRequest(region, `/catalog/2022-04-01/items/${asin}`, {
    marketplaceIds: marketplaceId,
    includedData: "salesRanks,summaries,images",
  }, token);

  const salesRanks  = (data.salesRanks || []).find(r => r.marketplaceId === marketplaceId) || {};
  const summaryList = (data.summaries  || []).find(s => s.marketplaceId === marketplaceId) || {};
  const imageList   = (data.images     || []).find(i => i.marketplaceId === marketplaceId) || {};
  const mainImage   = (imageList.images || []).find(img => img.variant === "MAIN");

  return {
    asin,
    title:               summaryList.itemName || null,
    brand:               summaryList.brand    || null,
    imageUrl:            mainImage?.link      || null,
    classificationRanks: salesRanks.classificationRanks || [],
    displayGroupRanks:   salesRanks.displayGroupRanks   || [],
    rawData:             data,
  };
}

// ─── FBA Inventory ────────────────────────────────────────────────────────────
async function getInventory(marketplaceId, refreshToken) {
  const token = refreshToken || process.env.SP_API_REFRESH_TOKEN;
  if (!token) throw new Error("SP_API_REFRESH_TOKEN not configured");
  const region = MARKETPLACE_REGION[marketplaceId] || "EU";

  let items = [];
  let nextToken = null;
  do {
    const params = { details: true, granularity: "Marketplace", granularityId: marketplaceId, marketplaceIds: marketplaceId };
    if (nextToken) params.nextToken = nextToken;
    const data = await _spRequest(region, "/fba/inventory/v1/summaries", params, token);
    items = items.concat(data.payload?.inventorySummaries || []);
    nextToken = data.pagination?.nextToken || null;
    if (nextToken) await _sleep(600);
  } while (nextToken);

  return items;
}

// ─── Orders ───────────────────────────────────────────────────────────────────
async function getOrders(marketplaceId, refreshToken, options = {}) {
  const token = refreshToken || process.env.SP_API_REFRESH_TOKEN;
  if (!token) throw new Error("SP_API_REFRESH_TOKEN not configured");
  const region = MARKETPLACE_REGION[marketplaceId] || "EU";

  // Amazon SP-API requires CreatedBefore/LastUpdatedBefore to be at least 2
  // minutes before current time (data has a ~2-minute ingestion lag). Use a
  // 3-minute buffer to be safe and clamp explicit overrides to never exceed
  // (now - 2 min). Without this clamp the Orders API returns 400 InvalidInput
  // and the daily orders sync silently fails.
  const MIN_LAG_MS = 2 * 60 * 1000;
  const SAFE_BEFORE_MS = 3 * 60 * 1000;
  const safeCutoff = Date.now() - MIN_LAG_MS;
  const createdAfter  = options.createdAfter  || new Date(Date.now() - 30 * 86400000).toISOString();
  const requestedBefore = options.createdBefore
    ? new Date(options.createdBefore).getTime()
    : Date.now() - SAFE_BEFORE_MS;
  const createdBefore = new Date(Math.min(requestedBefore, safeCutoff)).toISOString();

  let orders = [];
  let nextToken = null;
  do {
    const params = { MarketplaceIds: marketplaceId, MaxResultsPerPage: 100 };
    if (nextToken) {
      params.NextToken = nextToken;
    } else {
      params.CreatedAfter  = createdAfter;
      params.CreatedBefore = createdBefore;
      if (options.orderStatuses) params.OrderStatuses = options.orderStatuses.join(",");
    }
    const data = await _spRequest(region, "/orders/v0/orders", params, token);
    orders = orders.concat(data.payload?.Orders || []);
    nextToken = data.payload?.NextToken || null;
    if (nextToken) await _sleep(1200);
  } while (nextToken);

  return orders;
}

// ─── Order Items ──────────────────────────────────────────────────────────────
async function getOrderItems(amazonOrderId, marketplaceId, refreshToken) {
  const token = refreshToken || process.env.SP_API_REFRESH_TOKEN;
  if (!token) throw new Error("SP_API_REFRESH_TOKEN not configured");
  const region = MARKETPLACE_REGION[marketplaceId] || "EU";

  let items = [];
  let nextToken = null;
  do {
    const params = { MarketplaceIds: marketplaceId };
    if (nextToken) params.NextToken = nextToken;
    const data = await _spRequest(region, `/orders/v0/orders/${amazonOrderId}/orderItems`, params, token);
    items = items.concat(data.payload?.OrderItems || []);
    nextToken = data.payload?.NextToken || null;
    if (nextToken) await _sleep(400);
  } while (nextToken);

  return items;
}

// ─── Financial Events ─────────────────────────────────────────────────────────
const FINANCIAL_EVENT_GROUPS = {
  ShipmentEventList:                      "shipment",
  RefundEventList:                        "refund",
  GuaranteeClaimEventList:                "refund",
  ChargebackEventList:                    "refund",
  ServiceFeeEventList:                    "fee",
  RetrochargeEventList:                   "fee",
  LoanServicingEventList:                 "fee",
  AdjustmentEventList:                    "adjustment",
  FBALiquidationEventList:                "adjustment",
  SellerReviewEnrollmentPaymentEventList: "fee",
  ProductAdsPaymentEventList:             "fee",
  TrialShipmentEventList:                 "shipment",
};

async function getFinancialEvents(marketplaceId, refreshToken, options = {}) {
  const token = refreshToken || process.env.SP_API_REFRESH_TOKEN;
  if (!token) throw new Error("SP_API_REFRESH_TOKEN not configured");
  const region = MARKETPLACE_REGION[marketplaceId] || "EU";

  // Same 2-minute ingestion-lag rule as /orders — be defensive.
  const safeCutoff = Date.now() - 2 * 60 * 1000;
  const postedAfter  = options.postedAfter  || new Date(Date.now() - 30 * 86400000).toISOString();
  const requestedBefore = options.postedBefore
    ? new Date(options.postedBefore).getTime()
    : Date.now() - 3 * 60 * 1000;
  const postedBefore = new Date(Math.min(requestedBefore, safeCutoff)).toISOString();

  let allEvents = [];
  let nextToken = null;
  do {
    const params = { MaxResultsPerPage: 100 };
    if (nextToken) {
      params.NextToken = nextToken;
    } else {
      params.PostedAfter  = postedAfter;
      params.PostedBefore = postedBefore;
    }
    const data = await _spRequest(region, "/finances/v0/financialEvents", params, token);
    const fe = data.payload?.FinancialEvents || {};
    for (const [listKey, group] of Object.entries(FINANCIAL_EVENT_GROUPS)) {
      const eventType = listKey.replace("List", "");
      for (const ev of fe[listKey] || []) {
        allEvents.push({ event_type: eventType, event_group: group, raw: ev });
      }
    }
    nextToken = data.payload?.NextToken || null;
    if (nextToken) await _sleep(400);
  } while (nextToken);

  return allEvents;
}

// ─── Competitive Pricing ──────────────────────────────────────────────────────
async function getCompetitivePricing(asins, marketplaceId, refreshToken) {
  const token = refreshToken || process.env.SP_API_REFRESH_TOKEN;
  if (!token) throw new Error("SP_API_REFRESH_TOKEN not configured");
  const region = MARKETPLACE_REGION[marketplaceId] || "EU";

  const results = [];
  for (const batch of _chunk(asins, 20)) {
    const data = await _spRequest(region, "/products/pricing/v0/competitivePrice", {
      MarketplaceId: marketplaceId,
      Asins: batch.join(","),
      ItemType: "Asin",
    }, token);
    results.push(...(data.payload || []));
    if (asins.length > 20) await _sleep(200);
  }
  return results;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function _chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

module.exports = {
  getCatalogItem,
  getSpAccessToken,
  getInventory,
  getOrders,
  getOrderItems,
  getFinancialEvents,
  getCompetitivePricing,
};
