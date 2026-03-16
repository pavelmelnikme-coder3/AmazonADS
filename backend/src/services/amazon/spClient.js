const axios = require("axios");
const logger = require("../../config/logger");

// SP-API base URLs by region
const SP_API_URLS = {
  NA: process.env.SP_API_URL_NA || "https://sellingpartnerapi-na.amazon.com",
  EU: process.env.SP_API_URL_EU || "https://sellingpartnerapi-eu.amazon.com",
  FE: process.env.SP_API_URL_FE || "https://sellingpartnerapi-fe.amazon.com",
};

const MARKETPLACE_REGION = {
  ATVPDKIKX0DER: "NA", A2EUQ1WTGCTBG2: "NA", A1AM78C64UM0Y8: "NA",
  A1F83G8C2ARO7P: "EU", A1PA6795UKMFR9: "EU", APJ6JRA9NG5V4: "EU",
  A13V1IB3VIYZZH: "EU", A1RKKUPIHCS9HS: "EU",
  A39IBJ37TRP1C6: "FE", A1VC38T7YXB528: "FE", A21TJRUUN4KGV: "FE",
};

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

// In-memory token cache (keyed by first 20 chars of refresh token)
const tokenCache = new Map();

/**
 * Get SP-API access token from LwA using refresh_token.
 * SP-API uses its own client credentials (different from Ads API).
 */
async function getSpAccessToken(refreshToken) {
  const cacheKey = refreshToken.slice(0, 20);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.accessToken;
  }

  const response = await axios.post(LWA_TOKEN_URL, new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: process.env.SP_API_CLIENT_ID,
    client_secret: process.env.SP_API_CLIENT_SECRET,
  }), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });

  const { access_token, expires_in } = response.data;
  tokenCache.set(cacheKey, {
    accessToken: access_token,
    expiresAt: Date.now() + (expires_in - 60) * 1000,
  });
  return access_token;
}

/**
 * Get BSR (salesRanks) for an ASIN from SP-API Catalog Items v2022-04-01.
 *
 * @param {string} asin - Amazon ASIN
 * @param {string} marketplaceId - e.g. "A1PA6795UKMFR9" for DE
 * @param {string} [refreshToken] - SP-API refresh token, defaults to env var
 * @returns {Object} { asin, title, brand, imageUrl, classificationRanks, displayGroupRanks }
 */
async function getCatalogItem(asin, marketplaceId, refreshToken) {
  const token = refreshToken || process.env.SP_API_REFRESH_TOKEN;
  if (!token) throw new Error("SP_API_REFRESH_TOKEN not configured");

  const region = MARKETPLACE_REGION[marketplaceId] || "EU";
  const baseUrl = SP_API_URLS[region];
  const accessToken = await getSpAccessToken(token);

  const response = await axios.get(
    `${baseUrl}/catalog/2022-04-01/items/${asin}`,
    {
      params: {
        marketplaceIds: marketplaceId,
        includedData: "salesRanks,summaries,images",
      },
      headers: {
        "x-amz-access-token": accessToken,
        "x-amzn-requestid": `adsflow-${Date.now()}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );

  const item = response.data;

  const salesRanks = (item.salesRanks || []).find(
    (r) => r.marketplaceId === marketplaceId
  ) || {};

  const summaryList = (item.summaries || []).find(
    (s) => s.marketplaceId === marketplaceId
  ) || {};

  const imageList = (item.images || []).find(
    (i) => i.marketplaceId === marketplaceId
  ) || {};
  const mainImage = (imageList.images || []).find(
    (img) => img.variant === "MAIN"
  );

  return {
    asin,
    title: summaryList.itemName || null,
    brand: summaryList.brand || null,
    imageUrl: mainImage?.link || null,
    classificationRanks: salesRanks.classificationRanks || [],
    displayGroupRanks: salesRanks.displayGroupRanks || [],
  };
}

module.exports = { getCatalogItem, getSpAccessToken };
