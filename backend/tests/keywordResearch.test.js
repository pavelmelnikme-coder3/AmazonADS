"use strict";
/**
 * Keyword Research Routes — comprehensive test suite
 *
 * Covers:
 *   POST /keyword-research/discover
 *     — 400 when profileId missing
 *     — 400 when neither asins nor productTitle provided
 *     — 404 when profile not found in DB
 *     — returns discovered keywords from Amazon source
 *     — deduplicates across sources (higher relevance_score wins)
 *     — works when JS not configured (Amazon-only path)
 *     — includes jungle_scout source when configured
 *     — product_title auto-fetched from products table when not supplied
 *     — jungle_scout_available flag reflects jsConfigured()
 *
 *   POST /keyword-research/check-duplicates
 *     — returns empty duplicates when no keywords supplied
 *     — returns 403 when profileId does not belong to workspace
 *     — returns empty when no duplicates exist
 *     — returns in_profile=true when duplicate found
 *     — sets in_adgroup=true when match is in the specified ad group
 *
 *   POST /keyword-research/add-to-adgroup
 *     — 400 when keywords missing
 *     — 400 when adGroupId missing
 *     — 404 when ad group not found
 *     — adds keyword, skips existing, calls writeAudit
 *     — skipped++ when keyword already exists in that ad group
 *     — skipped++ when INSERT returns no row (ON CONFLICT)
 */

const request = require("supertest");
const express = require("express");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const WS_ID    = "ws---0001-0000-0000-000000000001";
const ORG_ID   = "org--0001-0000-0000-000000000001";
const USER_ID  = "user-0001-0000-0000-000000000001";
const PROF_ID  = "prof-0001-0000-0000-000000000001";
const AG_ID    = "ag---0001-0000-0000-000000000001";
const CAMP_ID  = "camp-0001-0000-0000-000000000001";

const PROFILE_ROW = {
  connection_id:      "conn-001",
  amazon_profile_id:  "123456789",
  marketplace_id:     "A1PA6795UKMFR9",
};

const AD_GROUP_ROW = {
  id:                AG_ID,
  amazon_ag_id:      "AZ_AG_001",
  campaign_id:       CAMP_ID,
  amazon_campaign_id:"AZ_CAMP_001",
  campaign_type:     "sponsoredProducts",
  profile_db_id:     PROF_ID,
  amazon_profile_id: "123456789",
  connection_id:     "conn-001",
  marketplace_id:    "A1PA6795UKMFR9",
};

const AMAZON_KW = {
  keyword_text:          "mushroom gummies",
  relevance_score:       90,
  source:                "amazon_ads",
  suggested_match_types: ["exact", "phrase"],
  match_type:            "exact",
};

const JS_KW = {
  keyword_text:          "lion mane supplement",
  relevance_score:       75,
  source:                "jungle_scout",
  suggested_match_types: ["broad"],
  match_type:            "broad",
  monthly_search_volume: 12000,
};

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock("../src/routes/audit", () => ({
  writeAudit:        jest.fn().mockResolvedValue("audit-id-001"),
  updateAuditStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/services/amazon/keywordRecommendations", () => ({
  getAmazonKeywordRecommendations: jest.fn(),
}));
jest.mock("../src/services/junglescout/client", () => ({
  getKeywordsByAsin:    jest.fn(),
  getKeywordsByKeyword: jest.fn(),
  getRanksByAsin:       jest.fn(),
  isConfigured:         jest.fn().mockReturnValue(false),
}));
jest.mock("../src/services/ai/keywordResearch", () => ({
  generateSeedKeywords:   jest.fn().mockResolvedValue([]),
  scoreAndFilterKeywords: jest.fn().mockImplementation(({ keywords }) =>
    Promise.resolve(keywords.map(k => ({ ...k, relevance_score: k.relevance_score ?? 70 })))
  ),
}));
jest.mock("../src/services/amazon/writeback", () => ({
  pushNewKeywords: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user  = { id: USER_ID, name: "Test User", role: "owner", org_id: ORG_ID };
    req.orgId = ORG_ID;
    next();
  },
  requireWorkspace: (req, _res, next) => {
    req.workspaceId   = WS_ID;
    req.workspaceRole = "owner";
    next();
  },
}));

const { query: dbQuery } = require("../src/db/pool");
const { writeAudit }     = require("../src/routes/audit");
const { getAmazonKeywordRecommendations } = require("../src/services/amazon/keywordRecommendations");
const {
  getKeywordsByAsin,
  getKeywordsByKeyword,
  getRanksByAsin,
  isConfigured: jsConfigured,
} = require("../src/services/junglescout/client");
const { pushNewKeywords } = require("../src/services/amazon/writeback");

const kwResearchRouter = require("../src/routes/keywordResearch");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/keyword-research", kwResearchRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: JS not configured, Amazon returns empty
  jsConfigured.mockReturnValue(false);
  getAmazonKeywordRecommendations.mockResolvedValue([]);
  getKeywordsByAsin.mockResolvedValue([]);
  getKeywordsByKeyword.mockResolvedValue([]);
  getRanksByAsin.mockResolvedValue(new Map());
});

// ═════════════════════════════════════════════════════════════════════════════
//  POST /keyword-research/discover
// ═════════════════════════════════════════════════════════════════════════════
describe("POST /keyword-research/discover", () => {
  test("returns 400 when profileId is missing", async () => {
    const res = await request(buildApp())
      .post("/keyword-research/discover")
      .send({ asins: ["B01MFAUXDD"], sources: ["amazon"] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/profileId required/i);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  test("returns 400 when neither asins nor productTitle are supplied", async () => {
    const res = await request(buildApp())
      .post("/keyword-research/discover")
      .send({ profileId: PROF_ID, sources: ["amazon"] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/asins or productTitle required/i);
  });

  test("returns 404 when profile is not found in DB", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] }); // profile lookup

    const res = await request(buildApp())
      .post("/keyword-research/discover")
      .send({ profileId: PROF_ID, asins: ["B01MFAUXDD"], sources: ["amazon"] });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/profile not found/i);
  });

  test("returns keywords from Amazon source when JS is not configured", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [PROFILE_ROW] }) // profile
      .mockResolvedValueOnce({ rows: [] });             // product title fallback

    getAmazonKeywordRecommendations.mockResolvedValueOnce([AMAZON_KW]);

    const res = await request(buildApp())
      .post("/keyword-research/discover")
      .send({
        profileId:    PROF_ID,
        asins:        ["B01MFAUXDD"],
        sources:      ["amazon"],
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("keywords");
    expect(res.body.keywords).toHaveLength(1);
    expect(res.body.keywords[0].keyword_text).toBe("mushroom gummies");
    expect(res.body.sources_used).toContain("amazon_ads");
    expect(res.body.jungle_scout_available).toBe(false);
  });

  test("deduplicates keywords across sources (higher relevance_score wins)", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [PROFILE_ROW] }) // profile
      .mockResolvedValueOnce({ rows: [] });             // product title

    // Both Amazon and JS return the same keyword with different scores
    const amazonDup = { ...AMAZON_KW, keyword_text: "mushroom gummies", relevance_score: 90 };
    const jsDup     = { ...JS_KW,     keyword_text: "Mushroom Gummies", relevance_score: 75, source: "jungle_scout" };

    getAmazonKeywordRecommendations.mockResolvedValueOnce([amazonDup]);
    jsConfigured.mockReturnValue(true);
    getKeywordsByAsin.mockResolvedValueOnce([jsDup]);

    const res = await request(buildApp())
      .post("/keyword-research/discover")
      .send({
        profileId: PROF_ID,
        asins:     ["B01MFAUXDD"],
        sources:   ["amazon", "jungle_scout"],
      });

    expect(res.status).toBe(200);
    // Should deduplicate — only one entry for "mushroom gummies"
    const kwTexts = res.body.keywords.map(k => k.keyword_text.toLowerCase());
    expect(kwTexts.filter(t => t === "mushroom gummies")).toHaveLength(1);
    // Higher score from Amazon wins
    const merged = res.body.keywords.find(k => k.keyword_text.toLowerCase() === "mushroom gummies");
    expect(merged.relevance_score).toBe(90);
  });

  test("merges source strings when same keyword comes from multiple sources", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [PROFILE_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    getAmazonKeywordRecommendations.mockResolvedValueOnce([
      { ...AMAZON_KW, keyword_text: "mushroom gummies" },
    ]);
    jsConfigured.mockReturnValue(true);
    getKeywordsByAsin.mockResolvedValueOnce([
      { ...JS_KW, keyword_text: "Mushroom Gummies", relevance_score: 60 },
    ]);

    const res = await request(buildApp())
      .post("/keyword-research/discover")
      .send({ profileId: PROF_ID, asins: ["B01MFAUXDD"], sources: ["amazon", "jungle_scout"] });

    expect(res.status).toBe(200);
    const kw = res.body.keywords.find(k => k.keyword_text.toLowerCase() === "mushroom gummies");
    expect(kw.source).toContain("amazon_ads");
    expect(kw.source).toContain("jungle_scout");
  });

  test("auto-fetches product title from products table when not provided", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [PROFILE_ROW] })                              // profile
      .mockResolvedValueOnce({ rows: [{ title: "Organic Mushroom Supplement" }] }); // product title

    getAmazonKeywordRecommendations.mockResolvedValueOnce([]);

    const res = await request(buildApp())
      .post("/keyword-research/discover")
      .send({ profileId: PROF_ID, asins: ["B01MFAUXDD"], sources: ["amazon"] });

    expect(res.status).toBe(200);
    expect(res.body.product_title).toBe("Organic Mushroom Supplement");
  });

  test("includes jungle_scout keywords when JS is configured", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [PROFILE_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    jsConfigured.mockReturnValue(true);
    getAmazonKeywordRecommendations.mockResolvedValueOnce([]);
    getKeywordsByAsin.mockResolvedValueOnce([JS_KW]);

    const res = await request(buildApp())
      .post("/keyword-research/discover")
      .send({ profileId: PROF_ID, asins: ["B01MFAUXDD"], sources: ["amazon", "jungle_scout"] });

    expect(res.status).toBe(200);
    expect(res.body.sources_used).toContain("jungle_scout");
    expect(res.body.keywords.some(k => k.keyword_text === "lion mane supplement")).toBe(true);
    expect(res.body.jungle_scout_available).toBe(true);
  });

  test("loads ad group context when adGroupId is provided", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [PROFILE_ROW] }) // profile
      .mockResolvedValueOnce({ rows: [{ amazon_ag_id: "AZ_AG_001", amazon_campaign_id: "AZ_CAMP_001" }] }) // ag context
      .mockResolvedValueOnce({ rows: [] }); // product title

    getAmazonKeywordRecommendations.mockResolvedValueOnce([AMAZON_KW]);

    const res = await request(buildApp())
      .post("/keyword-research/discover")
      .send({
        profileId:  PROF_ID,
        adGroupId:  AG_ID,
        asins:      ["B01MFAUXDD"],
        sources:    ["amazon"],
      });

    expect(res.status).toBe(200);
    // Amazon recommendations called with ag context
    expect(getAmazonKeywordRecommendations).toHaveBeenCalledWith(
      expect.objectContaining({ amazonAdGroupId: "AZ_AG_001" })
    );
  });

  test("sets default match_type from first suggested_match_types entry", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [PROFILE_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    const kwWithSuggested = {
      ...AMAZON_KW,
      suggested_match_types: ["phrase", "broad"],
      match_type: undefined,
    };
    getAmazonKeywordRecommendations.mockResolvedValueOnce([kwWithSuggested]);

    const res = await request(buildApp())
      .post("/keyword-research/discover")
      .send({ profileId: PROF_ID, asins: ["B01MFAUXDD"], sources: ["amazon"] });

    expect(res.status).toBe(200);
    const kw = res.body.keywords[0];
    expect(kw.match_type).toBe("phrase");
  });

  test("propagates unexpected errors as 500", async () => {
    dbQuery.mockRejectedValueOnce(new Error("DB failure"));

    const res = await request(buildApp())
      .post("/keyword-research/discover")
      .send({ profileId: PROF_ID, asins: ["B01MFAUXDD"], sources: ["amazon"] });

    expect(res.status).toBe(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  POST /keyword-research/check-duplicates
// ═════════════════════════════════════════════════════════════════════════════
describe("POST /keyword-research/check-duplicates", () => {
  test("returns empty duplicates when keywords array is empty", async () => {
    const res = await request(buildApp())
      .post("/keyword-research/check-duplicates")
      .send({ profileId: PROF_ID, keywords: [] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ duplicates: {} });
    expect(dbQuery).not.toHaveBeenCalled();
  });

  test("returns empty duplicates when keywords is not provided", async () => {
    const res = await request(buildApp())
      .post("/keyword-research/check-duplicates")
      .send({ profileId: PROF_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ duplicates: {} });
  });

  test("returns 403 when profile does not belong to workspace", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] }); // profile validation fails

    const res = await request(buildApp())
      .post("/keyword-research/check-duplicates")
      .send({
        profileId: PROF_ID,
        keywords: [{ keyword_text: "running shoes", match_type: "exact" }],
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/profile not found/i);
  });

  test("returns empty duplicates object when no matching keywords in DB", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: PROF_ID }] }) // profile exists
      .mockResolvedValueOnce({ rows: [] });                 // no matches

    const res = await request(buildApp())
      .post("/keyword-research/check-duplicates")
      .send({
        profileId: PROF_ID,
        keywords:  [{ keyword_text: "running shoes", match_type: "exact" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.duplicates).toEqual({});
  });

  test("marks in_profile=true when keyword+match_type found in same profile", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: PROF_ID }] })  // profile exists
      .mockResolvedValueOnce({ rows: [
        {
          kw:            "running shoes",
          match_type:    "exact",
          ad_group_id:   "other-ag",
          ag_name:       "Ad Group 1",
          campaign_name: "Campaign A",
        },
      ]});

    const res = await request(buildApp())
      .post("/keyword-research/check-duplicates")
      .send({
        profileId: PROF_ID,
        keywords:  [{ keyword_text: "Running Shoes", match_type: "exact" }],
      });

    expect(res.status).toBe(200);
    const key = "running shoes|exact";
    expect(res.body.duplicates[key]).toBeDefined();
    expect(res.body.duplicates[key].in_profile).toBe(true);
    expect(res.body.duplicates[key].in_adgroup).toBe(false);
    expect(res.body.duplicates[key].locations).toHaveLength(1);
    expect(res.body.duplicates[key].locations[0].campaign).toBe("Campaign A");
  });

  test("marks in_adgroup=true when duplicate is in the specified ad group", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: PROF_ID }] })
      .mockResolvedValueOnce({ rows: [
        {
          kw:            "running shoes",
          match_type:    "exact",
          ad_group_id:   AG_ID,            // same ad group as requested
          ag_name:       "Ad Group 1",
          campaign_name: "Campaign A",
        },
      ]});

    const res = await request(buildApp())
      .post("/keyword-research/check-duplicates")
      .send({
        profileId: PROF_ID,
        adGroupId: AG_ID,
        keywords:  [{ keyword_text: "running shoes", match_type: "exact" }],
      });

    expect(res.status).toBe(200);
    const key = "running shoes|exact";
    expect(res.body.duplicates[key].in_adgroup).toBe(true);
  });

  test("limits locations to 5 entries per keyword", async () => {
    const manyMatches = Array.from({ length: 8 }, (_, i) => ({
      kw: "running shoes", match_type: "broad",
      ad_group_id: `ag-${i}`, ag_name: `AG ${i}`, campaign_name: `Camp ${i}`,
    }));
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: PROF_ID }] })
      .mockResolvedValueOnce({ rows: manyMatches });

    const res = await request(buildApp())
      .post("/keyword-research/check-duplicates")
      .send({
        profileId: PROF_ID,
        keywords:  [{ keyword_text: "running shoes", match_type: "broad" }],
      });

    expect(res.status).toBe(200);
    const key = "running shoes|broad";
    expect(res.body.duplicates[key].locations).toHaveLength(5);
  });

  test("propagates DB errors as 500", async () => {
    dbQuery.mockRejectedValueOnce(new Error("DB failure"));
    const res = await request(buildApp())
      .post("/keyword-research/check-duplicates")
      .send({
        profileId: PROF_ID,
        keywords:  [{ keyword_text: "running shoes", match_type: "exact" }],
      });
    expect(res.status).toBe(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  POST /keyword-research/add-to-adgroup
// ═════════════════════════════════════════════════════════════════════════════
describe("POST /keyword-research/add-to-adgroup", () => {
  test("returns 400 when keywords array is missing", async () => {
    const res = await request(buildApp())
      .post("/keyword-research/add-to-adgroup")
      .send({ adGroupId: AG_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/keywords required/i);
  });

  test("returns 400 when keywords is an empty array", async () => {
    const res = await request(buildApp())
      .post("/keyword-research/add-to-adgroup")
      .send({ adGroupId: AG_ID, keywords: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/keywords required/i);
  });

  test("returns 400 when adGroupId is missing", async () => {
    const res = await request(buildApp())
      .post("/keyword-research/add-to-adgroup")
      .send({ keywords: [{ keyword_text: "running shoes", match_type: "exact" }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/adGroupId required/i);
  });

  test("returns 404 when ad group is not found in DB", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] }); // ag lookup

    const res = await request(buildApp())
      .post("/keyword-research/add-to-adgroup")
      .send({
        adGroupId: AG_ID,
        keywords:  [{ keyword_text: "running shoes", match_type: "exact" }],
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/ad group not found/i);
  });

  test("inserts keyword, calls writeAudit, returns added=1 skipped=0", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [AD_GROUP_ROW] })  // ag lookup
      .mockResolvedValueOnce({ rows: [] })               // dedup check → no existing
      .mockResolvedValueOnce({                           // INSERT INTO keywords
        rows: [{ id: "new-kw-id", keyword_text: "running shoes", match_type: "exact", bid: 0.50 }],
      });

    const res = await request(buildApp())
      .post("/keyword-research/add-to-adgroup")
      .send({
        adGroupId:  AG_ID,
        keywords:   [{ keyword_text: "running shoes", match_type: "exact" }],
        defaultBid: 0.50,
      });

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    expect(res.body.skipped).toBe(0);
    expect(res.body.success).toBe(true);

    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action:      "keyword.added",
        entityType:  "keyword",
        entityName:  "running shoes",
        orgId:       ORG_ID,
        workspaceId: WS_ID,
        actorId:     USER_ID,
        source:      "ui",
      })
    );
  });

  test("skips keyword when it already exists in that ad group (dedup check)", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [AD_GROUP_ROW] })     // ag lookup
      .mockResolvedValueOnce({ rows: [{ id: "existing" }] }); // dedup → found

    const res = await request(buildApp())
      .post("/keyword-research/add-to-adgroup")
      .send({
        adGroupId: AG_ID,
        keywords:  [{ keyword_text: "running shoes", match_type: "exact" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(0);
    expect(res.body.skipped).toBe(1);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  test("skips when INSERT returns no row (ON CONFLICT DO NOTHING path)", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [AD_GROUP_ROW] }) // ag
      .mockResolvedValueOnce({ rows: [] })              // dedup → none found
      .mockResolvedValueOnce({ rows: [] });             // INSERT → no row (conflict)

    const res = await request(buildApp())
      .post("/keyword-research/add-to-adgroup")
      .send({
        adGroupId: AG_ID,
        keywords:  [{ keyword_text: "running shoes", match_type: "exact" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(0);
    expect(res.body.skipped).toBe(1);
  });

  test("handles multiple keywords: adds some, skips others", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [AD_GROUP_ROW] }) // ag
      // kw1: no dedup, inserted
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "kw-new-1", keyword_text: "mushroom", match_type: "broad", bid: 0.50 }] })
      // kw2: dedup found → skip
      .mockResolvedValueOnce({ rows: [{ id: "kw-existing" }] });

    const res = await request(buildApp())
      .post("/keyword-research/add-to-adgroup")
      .send({
        adGroupId: AG_ID,
        keywords: [
          { keyword_text: "mushroom",      match_type: "broad" },
          { keyword_text: "lion mane",     match_type: "exact" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    expect(res.body.skipped).toBe(1);
  });

  test("clamps bid to minimum 0.02", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [AD_GROUP_ROW] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "kw-id", keyword_text: "cheap kw", match_type: "broad", bid: 0.02 }] });

    await request(buildApp())
      .post("/keyword-research/add-to-adgroup")
      .send({
        adGroupId: AG_ID,
        keywords:  [{ keyword_text: "cheap kw", match_type: "broad", bid_suggested: 0.001 }],
      });

    // The INSERT call params should include bid = 0.02 (clamped from 0.001)
    const insertCall = dbQuery.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO keywords")
    );
    expect(insertCall).toBeDefined();
    const bidParam = insertCall[1][7]; // 8th param is bid
    expect(bidParam).toBe(0.02);
  });

  test("skips blank keyword_text entries gracefully", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [AD_GROUP_ROW] }); // ag

    const res = await request(buildApp())
      .post("/keyword-research/add-to-adgroup")
      .send({
        adGroupId: AG_ID,
        keywords:  [{ keyword_text: "   ", match_type: "broad" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(0);
    expect(res.body.skipped).toBe(0); // blank is ignored, not counted as skipped
  });

  test("pushNewKeywords called in background for inserted keywords", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [AD_GROUP_ROW] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "kw-id", keyword_text: "mushroom", match_type: "exact", bid: 0.50 }] });

    await request(buildApp())
      .post("/keyword-research/add-to-adgroup")
      .send({
        adGroupId: AG_ID,
        keywords:  [{ keyword_text: "mushroom", match_type: "exact" }],
      });

    // pushNewKeywords is fire-and-forget; may not be called synchronously
    // but must be called eventually — give microtasks a chance to flush
    await new Promise(r => setImmediate(r));
    expect(pushNewKeywords).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ keywordText: "mushroom", matchType: "EXACT" }),
      ])
    );
  });

  test("propagates DB errors as 500", async () => {
    dbQuery.mockRejectedValueOnce(new Error("DB failure"));
    const res = await request(buildApp())
      .post("/keyword-research/add-to-adgroup")
      .send({ adGroupId: AG_ID, keywords: [{ keyword_text: "test", match_type: "broad" }] });
    expect(res.status).toBe(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Search history endpoints
// ═════════════════════════════════════════════════════════════════════════════
describe("GET /keyword-research/history", () => {
  test("returns the workspace search history list", async () => {
    const HIST_ROW = {
      id: "hist-0001", profile_id: PROF_ID, profile_name: "Acme · DE",
      locale: "de", sources: ["jungle_scout", "ai"], organic_top_n: 32,
      asins: ["B01MFAUXDD"], product_title: "Thermo container", url_input: null,
      ad_group_id: null, total: 162, sources_used: ["jungle_scout", "ai_generated"],
      created_at: new Date().toISOString(), created_by_name: "Test User",
    };
    dbQuery.mockResolvedValueOnce({ rows: [HIST_ROW] });

    const res = await request(buildApp()).get("/keyword-research/history");

    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0].total).toBe(162);
    // Workspace-scoped query
    expect(dbQuery).toHaveBeenCalledWith(expect.any(String), [WS_ID, 30]);
  });

  test("honours the limit query param (clamped to 50)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    await request(buildApp()).get("/keyword-research/history?limit=999");
    expect(dbQuery).toHaveBeenCalledWith(expect.any(String), [WS_ID, 50]);
  });

  test("propagates DB errors as 500", async () => {
    dbQuery.mockRejectedValueOnce(new Error("DB failure"));
    const res = await request(buildApp()).get("/keyword-research/history");
    expect(res.status).toBe(500);
  });
});

describe("GET /keyword-research/history/:id", () => {
  test("returns the full row including the result snapshot", async () => {
    const ROW = {
      id: "hist-0001", profile_id: PROF_ID, profile_name: "Acme · DE",
      locale: "de", sources: ["jungle_scout"], organic_top_n: 32,
      asins: ["B01MFAUXDD"], product_title: "Thermo", url_input: null,
      ad_group_id: null, total: 1, sources_used: ["jungle_scout"],
      result: { keywords: [{ keyword_text: "thermo" }], total: 1 },
      created_at: new Date().toISOString(),
    };
    dbQuery.mockResolvedValueOnce({ rows: [ROW] });

    const res = await request(buildApp()).get("/keyword-research/history/hist-0001");

    expect(res.status).toBe(200);
    expect(res.body.result.keywords).toHaveLength(1);
    expect(dbQuery).toHaveBeenCalledWith(expect.any(String), ["hist-0001", WS_ID]);
  });

  test("returns 404 when the search is not found in the workspace", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp()).get("/keyword-research/history/nope");
    expect(res.status).toBe(404);
  });
});

describe("DELETE /keyword-research/history/:id", () => {
  test("deletes a single search scoped to the workspace", async () => {
    dbQuery.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(buildApp()).delete("/keyword-research/history/hist-0001");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(dbQuery).toHaveBeenCalledWith(expect.any(String), ["hist-0001", WS_ID]);
  });
});

describe("DELETE /keyword-research/history", () => {
  test("clears the entire workspace history", async () => {
    dbQuery.mockResolvedValueOnce({ rowCount: 5 });
    const res = await request(buildApp()).delete("/keyword-research/history");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(dbQuery).toHaveBeenCalledWith(expect.any(String), [WS_ID]);
  });
});

describe("POST /keyword-research/export", () => {
  test("returns an xlsx attachment for valid columns + rows", async () => {
    const res = await request(buildApp())
      .post("/keyword-research/export")
      .responseType("blob")
      .send({
        columns: ["#", "Keyword", "Relevance"],
        rows: [[1, "thermo box", 95], [2, "lunch box", 80]],
        filename: "keywords-2026-05-29",
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/spreadsheetml\.sheet/);
    expect(res.headers["content-disposition"]).toMatch(/keywords-2026-05-29\.xlsx/);
    // XLSX files are ZIP archives — first two bytes are "PK"
    expect(Buffer.from(res.body).slice(0, 2).toString()).toBe("PK");
  });

  test("returns 400 when columns/rows are not arrays", async () => {
    const res = await request(buildApp())
      .post("/keyword-research/export")
      .send({ columns: "nope", rows: {} });
    expect(res.status).toBe(400);
  });
});
