"use strict";
/**
 * getAcceptHeader — the versioned media types Amazon requires
 *
 * Regression cover for the 406 found on 2026-08-18. The rule engine raised an SB campaign's
 * budget for the first time (30 → 36) and Amazon answered:
 *
 *   406 {"code":"406","details":"No match for accept header"}
 *
 * The function only mapped /sp/ paths, so every SB request went out as application/json and
 * was rejected before Amazon ever looked at the body. This failure mode is worth pinning: it
 * is invisible from the payload side — no field is wrong, the request simply never lands.
 *
 * Accept and Content-Type must also agree. They used to be derived differently (Content-Type
 * was hard-coded to application/json for anything outside /sp/), which is the asymmetry that
 * let the SB path go unnoticed.
 */

jest.mock("../src/services/amazon/lwa", () => ({
  getValidAccessToken: jest.fn(), refreshAccessToken: jest.fn(),
}));
jest.mock("../src/config/redis", () => ({ getRedis: jest.fn() }));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { getAcceptHeader } = require("../src/services/amazon/adsClient");

describe("getAcceptHeader — SB v4", () => {
  // The exact string entities.js already uses for POST /sb/v4/campaigns/list, which returns
  // live SB campaigns on production — so this is verified against Amazon, not read off a doc.
  it("gives SB campaigns their v4 resource media type", () => {
    expect(getAcceptHeader("/sb/v4/campaigns"))
      .toBe("application/vnd.sbcampaignresource.v4+json");
  });

  it("covers the sub-routes of the same resource", () => {
    expect(getAcceptHeader("/sb/v4/campaigns/list"))
      .toBe("application/vnd.sbcampaignresource.v4+json");
  });

  it("never falls back to plain JSON for an SB campaign path", () => {
    // The 406 in one assertion: application/json here is exactly what Amazon rejected.
    expect(getAcceptHeader("/sb/v4/campaigns")).not.toBe("application/json");
  });
});

describe("getAcceptHeader — unchanged behaviour for everything else", () => {
  it("keeps the SP v3 types", () => {
    expect(getAcceptHeader("/sp/campaigns")).toBe("application/vnd.spCampaign.v3+json");
    expect(getAcceptHeader("/sp/keywords")).toBe("application/vnd.spKeyword.v3+json");
    expect(getAcceptHeader("/sp/adGroups")).toBe("application/vnd.spAdGroup.v3+json");
    expect(getAcceptHeader("/sp/negativeKeywords"))
      .toBe("application/vnd.spNegativeKeyword.v3+json");
  });

  it("still resolves the more specific SP paths before the general ones", () => {
    expect(getAcceptHeader("/sp/campaignNegativeKeywords"))
      .toBe("application/vnd.spCampaignNegativeKeyword.v3+json");
    expect(getAcceptHeader("/sp/targets/keywords/recommendations"))
      .toBe("application/vnd.spkeywordsrecommendation.v4+json");
  });

  it("leaves SD and the unversioned endpoints on plain JSON", () => {
    // SD is still v2-style and does not take a vnd type; inventing one would break it.
    expect(getAcceptHeader("/sd/campaigns")).toBe("application/json");
    expect(getAcceptHeader("/v2/profiles")).toBe("application/json");
    expect(getAcceptHeader("/reporting/reports")).toBe("application/json");
  });
});
