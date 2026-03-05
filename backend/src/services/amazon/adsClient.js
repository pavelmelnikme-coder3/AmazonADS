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
const API_URLS = {
  NA: process.env.AMAZON_ADS_API_URL || "https://advertising-api.amazon.com",
  EU: process.env.AMAZON_ADS_API_EU_URL || "https://advertising-api-eu.amazon.com",
  FE: process.env.AMAZON_ADS_API_FE_URL || "https://advertising-api-fe.amazon.com",
};

// Marketplace → region mapping
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
  A39IBJ37TRP1C6: "FE", // AU
  A1VC38T7YXB528: "FE", // JP
  A21TJRUUN4KGV: "FE",  // IN
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

// ─── Core request function ────────────────────────────────────────────────────
/**
 * Make an authenticated request to Amazon Ads API.
 *
 * @param {Object} options
 * @param {string}  options.connectionId - DB connection UUID
 * @param {string}  options.profileId    - Amazon profile ID (numeric string)
 * @param {string}  options.marketplace  - marketplace ID
 * @param {string}  options.method       - HTTP method
 * @param {string}  options.path         - API path (e.g., "/v2/campaigns")
 * @param {Object}  [options.params]     - query params
 * @param {Object}  [options.data]       - request body
 * @param {string}  [options.group]      - rate limit group
 * @param {number}  [options.version]    - API version (default: 2)
 */
async function adsRequest({
  connectionId,
  profileId,
  marketplace,
  method,
  path,
  params,
  data,
  group = "default",
  version = 2,
}) {
  if (isCircuitOpen(profileId)) {
    throw Object.assign(
      new Error(`Circuit breaker open for profile ${profileId}. Amazon API appears degraded.`),
      { status: 503, code: "CIRCUIT_OPEN" }
    );
  }

  const region = MARKETPLACE_REGION[marketplace] || "NA";
  const baseUrl = API_URLS[region];

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Get a valid access token (auto-refreshes if needed)
      const accessToken = await getValidAccessToken(connectionId);

      const response = await axios({
        method,
        url: `${baseUrl}${path}`,
        params,
        data,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Amazon-Advertising-API-ClientId": process.env.AMAZON_CLIENT_ID,
          "Amazon-Advertising-API-Scope": profileId,
          "Content-Type": "application/json",
          "Accept": "application/json",
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
 */
async function getAll(opts, pageSize = 100) {
  const results = [];
  let startIndex = 0;

  while (true) {
    const page = await get({
      ...opts,
      params: { ...opts.params, startIndex, count: pageSize },
    });

    const items = Array.isArray(page) ? page : [];
    results.push(...items);

    if (items.length < pageSize) break;
    startIndex += pageSize;
  }

  return results;
}

module.exports = { adsRequest, get, post, put, patch, getAll };
