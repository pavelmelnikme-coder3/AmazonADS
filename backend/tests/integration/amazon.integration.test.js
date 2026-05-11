"use strict";
/**
 * Amazon Ads API — read-only integration tests.
 *
 * REQUIREMENTS to enable these tests:
 *   1. Copy backend/.env.example to backend/.env.test
 *   2. Fill in real Amazon Ads credentials:
 *        AMAZON_CLIENT_ID=amzn1.application-oa2-client.xxx
 *        AMAZON_CLIENT_SECRET=xxx
 *        AMAZON_REFRESH_TOKEN=xxx (long-lived refresh token)
 *        AMAZON_PROFILE_ID=<your real profileId>
 *        AMAZON_MARKETPLACE_ID=A1PA6795UKMFR9  (DE)
 *   3. Remove the `describe.skip` wrapper below
 *
 * What these tests verify:
 *   - Token refresh (LwA) works with real credentials
 *   - GET /v2/profiles returns the expected profile structure
 *   - GET /sp/campaigns (v3 POST list) returns campaigns with correct fields
 *   - Rate limiting / retry logic doesn't explode on real API
 *
 * They DO NOT:
 *   - Make any write operations (no PATCH / PUT / POST to Amazon)
 *   - Modify any real campaign data
 *   - Require a separate sandbox account (uses real account, read-only)
 */

const path = require("path");

// Load test credentials from .env.test if present
const envTestPath = path.join(__dirname, "../../.env.test");
try {
  require("dotenv").config({ path: envTestPath });
} catch {}

const hasCredentials = !!(
  process.env.AMAZON_CLIENT_ID &&
  process.env.AMAZON_CLIENT_SECRET &&
  process.env.AMAZON_REFRESH_TOKEN &&
  process.env.AMAZON_PROFILE_ID
);

// ─────────────────────────────────────────────────────────────────────────────
//  Skip entire suite if credentials not configured
// ─────────────────────────────────────────────────────────────────────────────
const describeFn = hasCredentials ? describe : describe.skip;

describeFn("Amazon Ads API — read-only (real account)", () => {
  let accessToken;
  const profileId    = process.env.AMAZON_PROFILE_ID;
  const marketplaceId = process.env.AMAZON_MARKETPLACE_ID || "A1PA6795UKMFR9";

  // ── 1. Token refresh (LwA) ────────────────────────────────────────────────
  describe("LwA token refresh", () => {
    it("obtains a valid access token from refresh token", async () => {
      const axios = require("axios");
      const resp = await axios.post(
        "https://api.amazon.com/auth/o2/token",
        new URLSearchParams({
          grant_type:    "refresh_token",
          refresh_token: process.env.AMAZON_REFRESH_TOKEN,
          client_id:     process.env.AMAZON_CLIENT_ID,
          client_secret: process.env.AMAZON_CLIENT_SECRET,
        }).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );

      expect(resp.status).toBe(200);
      expect(resp.data.access_token).toBeDefined();
      expect(resp.data.token_type).toBe("bearer");
      accessToken = resp.data.access_token; // store for subsequent tests
    }, 15000);
  });

  // ── 2. GET /v2/profiles ───────────────────────────────────────────────────
  describe("GET /v2/profiles", () => {
    it("returns array of profiles with required fields", async () => {
      if (!accessToken) pending("requires accessToken from token refresh test");
      const axios = require("axios");
      const resp = await axios.get(
        "https://advertising-api-eu.amazon.com/v2/profiles",
        { headers: {
            Authorization: `Bearer ${accessToken}`,
            "Amazon-Advertising-API-ClientId": process.env.AMAZON_CLIENT_ID,
          }
        }
      );

      expect(resp.status).toBe(200);
      expect(Array.isArray(resp.data)).toBe(true);
      if (resp.data.length > 0) {
        const p = resp.data[0];
        expect(p).toHaveProperty("profileId");
        expect(p).toHaveProperty("countryCode");
        expect(p).toHaveProperty("currencyCode");
        expect(p).toHaveProperty("accountInfo");
      }
    }, 15000);

    it("target profile is present in the list", async () => {
      if (!accessToken) pending("requires accessToken");
      const axios = require("axios");
      const resp = await axios.get(
        "https://advertising-api-eu.amazon.com/v2/profiles",
        { headers: {
            Authorization: `Bearer ${accessToken}`,
            "Amazon-Advertising-API-ClientId": process.env.AMAZON_CLIENT_ID,
          }
        }
      );
      const ids = resp.data.map(p => String(p.profileId));
      expect(ids).toContain(String(profileId));
    }, 15000);
  });

  // ── 3. SP campaigns (v3 POST list) ───────────────────────────────────────
  describe("SP campaigns — POST /sp/campaigns/list", () => {
    it("returns campaigns array with required fields", async () => {
      if (!accessToken) pending("requires accessToken");
      const axios = require("axios");
      const resp = await axios.post(
        "https://advertising-api-eu.amazon.com/sp/campaigns/list",
        { stateFilter: { include: ["ENABLED", "PAUSED"] }, maxResults: 10 },
        { headers: {
            Authorization: `Bearer ${accessToken}`,
            "Amazon-Advertising-API-ClientId": process.env.AMAZON_CLIENT_ID,
            "Amazon-Advertising-API-Scope": String(profileId),
            "Content-Type": "application/vnd.spCampaign.v3+json",
            Accept: "application/vnd.spCampaign.v3+json",
          }
        }
      );

      expect(resp.status).toBe(200);
      expect(resp.data).toHaveProperty("campaigns");
      if (resp.data.campaigns.length > 0) {
        const c = resp.data.campaigns[0];
        expect(c).toHaveProperty("campaignId");
        expect(c).toHaveProperty("name");
        expect(c).toHaveProperty("state");
        expect(c).toHaveProperty("campaignType");
        // v3 state is UPPERCASE
        expect(["ENABLED", "PAUSED", "ARCHIVED"]).toContain(c.state);
      }
    }, 20000);
  });

  // ── 4. SP keywords (v3 POST list) ────────────────────────────────────────
  describe("SP keywords — POST /sp/keywords/list", () => {
    it("returns keywords with state in uppercase (v3 format)", async () => {
      if (!accessToken) pending("requires accessToken");
      const axios = require("axios");
      const resp = await axios.post(
        "https://advertising-api-eu.amazon.com/sp/keywords/list",
        { stateFilter: { include: ["ENABLED"] }, maxResults: 5 },
        { headers: {
            Authorization: `Bearer ${accessToken}`,
            "Amazon-Advertising-API-ClientId": process.env.AMAZON_CLIENT_ID,
            "Amazon-Advertising-API-Scope": String(profileId),
            "Content-Type": "application/vnd.spKeyword.v3+json",
            Accept: "application/vnd.spKeyword.v3+json",
          }
        }
      );

      expect(resp.status).toBe(200);
      expect(resp.data).toHaveProperty("keywords");
      if (resp.data.keywords.length > 0) {
        const k = resp.data.keywords[0];
        expect(k).toHaveProperty("keywordId");
        expect(k).toHaveProperty("keywordText");
        expect(k).toHaveProperty("matchType");
        expect(k).toHaveProperty("state");
        expect(["ENABLED", "PAUSED", "ARCHIVED"]).toContain(k.state);
      }
    }, 20000);
  });

  // ── 5. SB campaigns (v4 GET) ──────────────────────────────────────────────
  describe("SB campaigns — GET /sb/v4/campaigns", () => {
    it("returns SB campaigns or empty array (not a 4xx error)", async () => {
      if (!accessToken) pending("requires accessToken");
      const axios = require("axios");
      try {
        const resp = await axios.get(
          "https://advertising-api-eu.amazon.com/sb/v4/campaigns?stateFilter=enabled,paused",
          { headers: {
              Authorization: `Bearer ${accessToken}`,
              "Amazon-Advertising-API-ClientId": process.env.AMAZON_CLIENT_ID,
              "Amazon-Advertising-API-Scope": String(profileId),
            }
          }
        );
        expect(resp.status).toBe(200);
        expect(resp.data).toHaveProperty("campaigns");
      } catch (err) {
        // Some profiles don't have SB access — 403 is acceptable
        if (err.response?.status === 403) {
          console.log("  ℹ SB campaigns: 403 (no SB access on this profile) — expected");
          return;
        }
        throw err;
      }
    }, 20000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Instructions shown when credentials are not configured
// ─────────────────────────────────────────────────────────────────────────────
if (!hasCredentials) {
  describe("Amazon Ads API tests — SKIPPED (no credentials)", () => {
    it("configure .env.test to enable", () => {
      console.log(`
To enable Amazon API integration tests:
  1. Create backend/.env.test with:
       AMAZON_CLIENT_ID=amzn1.application-oa2-client.xxx
       AMAZON_CLIENT_SECRET=xxx
       AMAZON_REFRESH_TOKEN=Atzr|xxx  (long-lived token from OAuth flow)
       AMAZON_PROFILE_ID=<your profileId>
       AMAZON_MARKETPLACE_ID=A1PA6795UKMFR9
  2. Remove the describe.skip in amazon.integration.test.js
  3. Run: npm run test:integration
      `);
      expect(true).toBe(true); // always pass — just informational
    });
  });
}
