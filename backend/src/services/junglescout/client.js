/**
 * Jungle Scout API Client — Keyword Research
 *
 * Required env vars:
 *   JUNGLE_SCOUT_KEY_NAME  — key name (letters, numbers, underscores only)
 *   JUNGLE_SCOUT_API_KEY   — API key
 *
 * Docs: https://developer.junglescout.com/api/keywords
 * Auth: Authorization: KEY_NAME:API_KEY header
 * Method: POST with JSON API body (not GET with query params)
 * Rate limit: 300 req/min (15/sec)
 */

const axios = require("axios");
const logger = require("../../config/logger");

const BASE_URL = "https://developer.junglescout.com";

function isConfigured() {
  return !!(process.env.JUNGLE_SCOUT_KEY_NAME && process.env.JUNGLE_SCOUT_API_KEY);
}

function getHeaders() {
  return {
    Authorization: `${process.env.JUNGLE_SCOUT_KEY_NAME}:${process.env.JUNGLE_SCOUT_API_KEY}`,
    "Content-Type": "application/vnd.api+json",
    Accept: "application/vnd.junglescout.v1+json",
    "X-API-Type": "junglescout",
  };
}

// Amazon marketplace string ID → Jungle Scout marketplace code
const MARKETPLACE_CODE = {
  ATVPDKIKX0DER: "us",
  A2EUQ1WTGCTBG2: "ca",
  A1AM78C64UM0Y8: "mx",
  A1F83G8C2ARO7P: "gb",
  A1PA6795UKMFR9: "de",
  APJ6JRA9NG5V4:  "it",
  A13V1IB3VIYZZH: "fr",
  A1RKKUPIHCS9HS: "es",
  A39IBJ37TRP1C6: "au",
  A1VC38T7YXB528: "jp",
  A21TJRUUN4KGV:  "in",
};

function parseKeywords(data, source = "jungle_scout") {
  const items = data?.data || [];
  return items.map(item => {
    const attrs = item.attributes || {};
    const keyword = attrs.name || attrs.keyword || attrs.keyword_text;
    if (!keyword) return null;
    return {
      keyword_text: keyword,
      match_type: "broad",
      suggested_match_types: ["exact", "phrase", "broad"],
      monthly_search_volume: attrs.monthly_search_volume_exact
        || attrs.monthly_search_volume_broad
        || attrs.approximate_30_day_search_volume
        || null,
      relevancy_score: attrs.relevancy_score || null,
      ease_of_ranking: attrs.ease_of_ranking_score || null,
      source,
    };
  }).filter(Boolean);
}

/**
 * Get keywords that one or more ASINs rank for (reverse-ASIN lookup).
 * @param {string[]} asins      - up to 10 ASINs
 * @param {string}   marketplaceId - Amazon marketplace string ID
 */
async function getKeywordsByAsin(asins, marketplaceId) {
  if (!isConfigured() || !asins?.length) return [];

  const marketplace = MARKETPLACE_CODE[marketplaceId] || "us";

  try {
    const { data } = await axios.post(
      `${BASE_URL}/api/keywords/keywords_by_asin_query`,
      {
        data: {
          type: "keywords_by_asin_query",
          attributes: {
            asins: asins.slice(0, 10),
            include_variants: true,
          },
        },
      },
      {
        headers: getHeaders(),
        params: {
          marketplace,
          sort: "-monthly_search_volume_exact",
          "page[size]": 100,
        },
        timeout: 20000,
      }
    );
    const results = parseKeywords(data, "jungle_scout_asin");
    logger.info("Jungle Scout keywords by ASIN", { asins, count: results.length });
    return results;
  } catch (e) {
    logger.warn("Jungle Scout ASIN lookup failed (non-fatal)", {
      error: e.response?.data?.errors?.[0]?.detail || e.message,
      status: e.response?.status,
      body: JSON.stringify(e.response?.data).slice(0, 300),
    });
    return [];
  }
}

/**
 * Get related keywords by expanding a seed keyword.
 * @param {string} keyword
 * @param {string} marketplaceId
 */
async function getKeywordsByKeyword(keyword, marketplaceId) {
  if (!isConfigured() || !keyword) return [];

  const marketplace = MARKETPLACE_CODE[marketplaceId] || "us";

  try {
    const { data } = await axios.post(
      `${BASE_URL}/api/keywords/keywords_by_keyword_query`,
      {
        data: {
          type: "keywords_by_keyword_query",
          attributes: {
            search_terms: [keyword],
          },
        },
      },
      {
        headers: getHeaders(),
        params: {
          marketplace,
          sort: "-monthly_search_volume_exact",
          "page[size]": 50,
        },
        timeout: 15000,
      }
    );
    const results = parseKeywords(data, "jungle_scout_expand");
    logger.info("Jungle Scout keyword expansion", { keyword, count: results.length });
    return results;
  } catch (e) {
    logger.warn("Jungle Scout keyword expansion failed (non-fatal)", {
      error: e.response?.data?.errors?.[0]?.detail || e.message,
      status: e.response?.status,
      body: JSON.stringify(e.response?.data).slice(0, 300),
    });
    return [];
  }
}

/**
 * Get organic ranks of an ASIN for all its ranked keywords.
 * Returns a Map: lowercased keyword → { position, page, found, blocked }.
 * Fetches up to 2 pages (200 keywords) to cover most tracked keywords.
 * @param {string} asin
 * @param {string} marketplaceId
 */
async function getRanksByAsin(asin, marketplaceId) {
  if (!isConfigured() || !asin) return new Map();

  const marketplace = MARKETPLACE_CODE[marketplaceId] || "us";
  const rankMap = new Map();

  const fetchPage = async (cursor) => {
    const params = {
      marketplace,
      sort: "-monthly_search_volume_exact",
      "page[size]": 100,
      ...(cursor ? { "page[cursor]": cursor } : {}),
    };
    const { data } = await axios.post(
      `${BASE_URL}/api/keywords/keywords_by_asin_query`,
      { data: { type: "keywords_by_asin_query", attributes: { asins: [asin], include_variants: false } } },
      { headers: getHeaders(), params, timeout: 25000 }
    );
    for (const item of (data?.data || [])) {
      const attrs = item.attributes || {};
      const kw = attrs.name;
      if (kw && attrs.organic_rank != null) {
        rankMap.set(kw.toLowerCase(), {
          position: attrs.organic_rank,
          page: Math.ceil(attrs.organic_rank / 16),
          found: true,
          blocked: false,
          search_volume: attrs.monthly_search_volume_exact
            || attrs.monthly_search_volume_broad
            || attrs.approximate_30_day_search_volume
            || null,
        });
      }
    }
    const nextUrl = data?.links?.next;
    if (!nextUrl) return null;
    try { return new URL(nextUrl).searchParams.get("page[cursor]"); } catch { return null; }
  };

  try {
    const cursor = await fetchPage(null);
    if (cursor) await fetchPage(cursor);
    logger.info("Jungle Scout rank check", { asin, count: rankMap.size });
  } catch (e) {
    logger.warn("Jungle Scout rank check failed (non-fatal)", {
      error: e.response?.data?.errors?.[0]?.detail || e.message,
      status: e.response?.status,
    });
  }
  return rankMap;
}

module.exports = { getKeywordsByAsin, getKeywordsByKeyword, getRanksByAsin, isConfigured };
