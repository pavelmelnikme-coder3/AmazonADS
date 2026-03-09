/**
 * Amazon Ads API Client
 *
 * Handles:
 * - Per-profile, per-endpoint-group rate limiting
 * - Exponential backoff + jitter on 429/5xx
 * - Automatic token refresh
 * - Request deduplication
 * - Circuit breaker on repeated failures
 *
 * Amazon Ads API docs: https://advertising.amazon.com/API/docs/en-us
 */

const axios = require("axios");
const { getValidAccessToken } = require("./lwa");
const logger = require("../../config/logger");
const { getRedis } = require("../../config/redis");

// ─── API Base URLs by region ──────────────────────────────────────────────────
// Always force https:// — env vars may accidentally contain http://
function forceHttps(url) {
  if (!url) return url;
  return url.replace(/^http:\/\//i, "https://");
}

const API_URLS = {
  NA: forceHttps(process.env.AMAZON_ADS_API_URL)    || "https://advertising-api.amazon.com",
  EU: forceHttps(process.env.AMAZON_ADS_API_EU_URL) || "https://advertising-api-eu.amazon.com",
  FE: forceHttps(process.env.AMAZON_ADS_API_FE_URL) || "https://advertising-api-fe.amazon.com",
};

// Amazon marketplace string ID → region
const MARKETPLACE_REGION = {
  ATVPDKIKX0DER: "NA", // US
  A2EUQ1WTGCTBG2: "NA", // CA
  A1AM78C64UM0Y8: "NA", // MX
  A1F83G8C2ARO7P: "EU", // UK
  A1PA6795UKMFR9: "EU", // DE
  APJ6JRA9NG5V4: "EU",  // IT
  A13V1IB3VIYZZH: "EU", // FR
  A1RKKUPIHCS9HS: "EU", // ES
  A17E79C6D8DWNP: "EU", // SA
  A2VIGQ35RCS4UG: "EU", // AE
  A1MNDV6DTONNN6: "EU", // NL
  A2NODRKZP88ZB9: "EU", // SE
  A1C3SOZRARQ6R3: "EU", // PL
  A33AVAJ2PDY3EV: "EU", // TR
  A39IBJ37TRP1C6: "FE", // AU
  A1VC38T7YXB528: "FE", // JP
  A21TJRUUN4KGV:  "FE", // IN
  A19VAU5U5O7RUS: "FE", // SG
};

// Country code → region fallback (used when marketplace string ID is missing/unknown)
const COUNTRY_REGION = {
  US: "NA", CA: "NA", MX: "NA",
  GB: "EU", UK: "EU", DE: "EU", FR: "EU", IT: "EU",
  ES: "EU", NL: "EU", SE: "EU", PL: "EU", TR: "EU",
  SA: "EU", AE: "EU", BE: "EU", EG: "EU",
  JP: "FE", AU: "FE", SG: "FE", IN: "FE",
};

// ─── Rate limit config per endpoint group ────────────────────────────────────
// Amazon uses per-resource rate limits; these are conservative defaults
const RATE_LIMITS = {
  campaigns:   { rpm: 60,  rph: 600 },
  ad_groups:   { rpm: 60,  rph: 600 },
  keywords:    { rpm: 60,  rph: 600 },
  reports:     { rpm: 30,  rph: 200 },  // stricter for reports
  profiles:    { rpm: 10,  rph: 100 },
  default:     { rpm: 60,  rph: 600 },
};

// ─── Retry config ─────────────────────────────────────────────────────────────
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

// ─── Circuit breaker state (in-memory; use Redis in multi-instance) ───────────
const circuitState = new Map(); // profileId → { failures, openedAt }
const CB_THRESHOLD = 10;        // failures before open
const CB_RESET_MS  = 60 * 1000; // 1 minute cooldown

function isCircuitOpen(profileId) {
  const state = circuitState.get(profileId);
  if (!state) return false;

  if (state.openedAt && Date.now() - state.openedAt > CB_RESET_MS) {
    // Half-open: try one request
    circuitState.delete(profileId);
    return false;
  }

  return state.failures >= CB_THRESHOLD;
}

function recordFailure(profileId) {
  const state = circuitState.get(profileId) || { failures: 0 };
  state.failures += 1;
  if (state.failures >= CB_THRESHOLD) state.openedAt = Date.now();
  circuitState.set(profileId, state);
}

function recordSuccess(profileId) {
  circuitState.delete(profileId);
}

// ─── Versioned Accept headers for SP v3 endpoints ─────────────────────────────
// Amazon Ads API v3 requires content-type versioning for SP sub-resources
function getAcceptHeader(path) {
  if (path.includes("/sp/adGroups"))           return "application/vnd.spAdGroup.v3+json";
  if (path.includes("/sp/keywords"))           return "application/vnd.spKeyword.v3+json";
  if (path.includes("/sp/productAds"))         return "application/vnd.spProductAd.v3+json";
  if (path.includes("/sp/negativeKeywords"))   return "application/vnd.spNegativeKeyword.v3+json";
  if (path.includes("/sp/negativeTargets"))    return "application/vnd.spNegativeTargetingClause.v3+json";
  if (path.includes("/sp/targets"))            return "application/vnd.spTargetingClause.v3+json";
  if (path.includes("/sp/campaigns"))          return "application/vnd.spCampaign.v3+json";
  return "application/json";
}

// ─── Core request function ────────────────────────────────────────────────────
/**
 * Make an authenticated request to Amazon Ads API.
 *
 * @param {Object} options
 * @param {string}  options.connectionId - DB connection UUID
 * @param {string}  options.profileId    - Amazon profile ID (numeric string) — used as API Scope header
 * @param {string}  options.marketplace  - Amazon marketplace string ID (e.g. "A1PA6795UKMFR9")
 * @param {string}  [options.countryCode]- ISO country code fallback for region (e.g. "DE"), used when marketplace ID is unknown
 * @param {string}  options.method       - HTTP method
 * @param {string}  options.path         - API path (e.g., "/sp/campaigns")
 * @param {Object}  [options.params]     - query params
 * @param {Object}  [options.data]       - request body
 * @param {string}  [options.group]      - rate limit group
 */
async function adsRequest({
  connectionId,
  profileId,
  marketplace,
  countryCode,
  method,
  path,
  params,
  data,
  group = "default",
}) {
  if (isCircuitOpen(profileId)) {
    throw Object.assign(
      new Error(`Circuit breaker open for profile ${profileId}. Amazon API appears degraded.`),
      { status: 503, code: "CIRCUIT_OPEN" }
    );
  }

  // Resolve region: try marketplace string ID first, then country code, then default EU
  const region = MARKETPLACE_REGION[marketplace]
    || COUNTRY_REGION[(countryCode || "").toUpperCase()]
    || "EU";
  const baseUrl = API_URLS[region];

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Get a valid access token (auto-refreshes if needed)
      const accessToken = await getValidAccessToken(connectionId);

      // Log right before every request so we can see exactly what is sent
      logger.info("Amazon Ads API request", {
        connectionId,          // DB UUID of the connection whose token is used
        profileId,             // Amazon numeric profile ID — sent as API Scope header
        scopeHeader: profileId,
        marketplace,
        countryCode,
        region,
        url: `${baseUrl}${path}`,
        method,
        attempt,
      });

      const response = await axios({
        method,
        url: `${baseUrl}${path}`,
        params,
        data,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Amazon-Advertising-API-ClientId": process.env.AMAZON_CLIENT_ID,
          "Amazon-Advertising-API-Scope": profileId,  // must be the Amazon numeric profile ID
          "Accept": getAcceptHeader(path),
          "Content-Type": path.startsWith("/sp/") ? getAcceptHeader(path) : "application/json",
        },
        timeout: 30000,
        validateStatus: null, // Handle all status codes manually
      });

      // Success
      if (response.status >= 200 && response.status < 300) {
        recordSuccess(profileId);
        return response.data;
      }

      // Rate limited
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers["retry-after"] || "5", 10);
        const delay = Math.min(retryAfter * 1000, MAX_DELAY_MS);
        logger.warn("Amazon API rate limited", { profileId, path, attempt, retryAfterSec: retryAfter });

        if (attempt < MAX_RETRIES) {
          await sleep(delay + jitter(500));
          continue;
        }
        throw Object.assign(new Error("Amazon API rate limit exceeded"), { status: 429 });
      }

      // Server errors - retry
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        const delay = exponentialBackoff(attempt);
        logger.warn("Amazon API server error, retrying", { profileId, path, status: response.status, attempt, delayMs: delay });
        await sleep(delay);
        continue;
      }

      // Client errors - don't retry
      const error = new Error(`Amazon API error: ${response.status} ${JSON.stringify(response.data)}`);
      error.status = response.status;
      error.amazonResponse = response.data;
      throw error;

    } catch (err) {
      lastError = err;

      // Network errors - retry
      if (err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ECONNREFUSED") {
        if (attempt < MAX_RETRIES) {
          const delay = exponentialBackoff(attempt);
          logger.warn("Network error, retrying", { profileId, path, error: err.code, attempt, delayMs: delay });
          await sleep(delay);
          continue;
        }
        recordFailure(profileId);
      }

      throw err;
    }
  }

  recordFailure(profileId);
  throw lastError;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(maxMs) {
  return Math.random() * maxMs;
}

function exponentialBackoff(attempt) {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay + jitter(500), MAX_DELAY_MS);
}

// ─── Convenience wrappers ─────────────────────────────────────────────────────
function get(opts) { return adsRequest({ ...opts, method: "GET" }); }
function post(opts) { return adsRequest({ ...opts, method: "POST" }); }
function put(opts) { return adsRequest({ ...opts, method: "PUT" }); }
function patch(opts) { return adsRequest({ ...opts, method: "PATCH" }); }

/**
 * Paginated GET — automatically follows pages and collects all results.
 * Amazon uses startIndex + count pagination for most list endpoints.
 *
 * @param {string} [opts.responseKey] - if set, unwrap page[responseKey] instead of assuming plain array
 *                                      (Amazon Ads API v3 wraps results: { campaigns: [...] })
 */
async function getAll(opts, pageSize = 100) {
  const results = [];
  let startIndex = 0;

  while (true) {
    const page = await get({
      ...opts,
      params: { ...opts.params, startIndex, count: pageSize },
    });

    // Log the raw first-page response when debug is requested (helps diagnose count=0 issues)
    if (startIndex === 0 && opts.debug) {
      logger.info("getAll raw first page response", {
        path: opts.path,
        responseKey: opts.responseKey,
        isArray: Array.isArray(page),
        topLevelKeys: page && typeof page === "object" ? Object.keys(page) : [],
        sample: JSON.stringify(page).slice(0, 600),
      });
    }

    let items;
    if (Array.isArray(page)) {
      items = page;
    } else if (opts.responseKey && Array.isArray(page?.[opts.responseKey])) {
      items = page[opts.responseKey];
    } else {
      // Try common wrapper keys as fallback
      const knownKeys = ["campaigns", "adGroups", "keywords", "ads", "targetingClauses", "productAds", "portfolios"];
      const found = knownKeys.find(k => Array.isArray(page?.[k]));
      items = found ? page[found] : [];
    }

    results.push(...items);

    if (items.length < pageSize) break;
    startIndex += pageSize;
  }

  return results;
}

module.exports = { adsRequest, get, post, put, patch, getAll };
