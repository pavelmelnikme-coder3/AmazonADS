"use strict";
/**
 * ingestSearchTermData — pre-aggregation at the report's own granularity.
 *
 * Amazon emits the search-term report per (date, campaign, ad group, keyword, match type,
 * search term): the same shopper query comes back once for every keyword that matched it.
 * The upsert key used to be only (workspace, campaign, query, dates), so all of those rows
 * collided on one slot and `DO UPDATE SET clicks = EXCLUDED.clicks` overwrote instead of
 * adding — the last row processed won and the rest vanished.
 *
 * Measured against the live 2026-09-06 SP report: 392 rows in, 383 stored; 547 clicks and
 * EUR 322.46 became 527 clicks and EUR 305.99. Those are exactly the numbers the
 * negative-keyword rules threshold on ("8 clicks, 0 orders"), so the loss showed up as
 * negatives the rules never added.
 */
jest.mock("../src/db/pool", () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { query: dbQuery } = require("../src/db/pool");
const { ingestSearchTermData } = require("../src/services/amazon/reporting");

const WS = "ws-1", PROF = "prof-1";
// Param indexes in the INSERT values array.
const IDX = {
  campaign: 2, adGroup: 3, query: 6, keywordText: 8, matchType: 9,
  impressions: 10, clicks: 11, spend: 12, orders: 13, sales: 14,
  dateStart: 15, amazonCampaign: 17, amazonAdGroup: 18,
};

const inserts = () =>
  dbQuery.mock.calls.filter(c => /INSERT INTO search_term_metrics/.test(c[0])).map(c => c[1]);

// Resolve the campaign/ad group/keyword lookups the ingest does before each upsert, so the
// campaign-known branch (and its wider conflict target) is the one under test.
function resolveLookups() {
  dbQuery.mockImplementation((sql, params) => {
    if (/SELECT id FROM campaigns/.test(sql))  return Promise.resolve({ rows: [{ id: `camp-${params[0]}` }] });
    if (/SELECT id FROM ad_groups/.test(sql))  return Promise.resolve({ rows: [{ id: `ag-${params[0]}` }] });
    if (/SELECT id FROM keywords/.test(sql))   return Promise.resolve({ rows: [{ id: `kw-${params[0]}` }] });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveLookups();
});

describe("search-term ingest aggregation", () => {
  test("sums the rows of every keyword that matched the same term in one ad group", async () => {
    // This is the shape that lost 9 of "keilkissen bett"'s 10 live clicks on 2026-09-06.
    const rows = [
      { searchTerm: "keilkissen bett", date: "2026-09-06", campaignId: 1, adGroupId: 10, keywordId: 100, keyword: "keilkissen", matchType: "BROAD", clicks: 6, cost: 4.5, impressions: 300, purchases14d: 0, sales14d: 0 },
      { searchTerm: "keilkissen bett", date: "2026-09-06", campaignId: 1, adGroupId: 10, keywordId: 101, keyword: "keilkissen", matchType: "BROAD", clicks: 3, cost: 2.0, impressions: 120, purchases14d: 0, sales14d: 0 },
      { searchTerm: "keilkissen bett", date: "2026-09-06", campaignId: 1, adGroupId: 10, keywordId: 102, keyword: "keilkissen", matchType: "BROAD", clicks: 1, cost: 0.5, impressions: 40,  purchases14d: 0, sales14d: 0 },
    ];

    const n = await ingestSearchTermData({ workspaceId: WS, profileDbId: PROF, rows, startDate: "2026-09-06", endDate: "2026-09-06" });

    expect(n).toBe(1);
    const [ins] = inserts();
    expect(ins[IDX.clicks]).toBe(10);       // 6+3+1 summed, not overwritten to 1
    expect(ins[IDX.spend]).toBeCloseTo(7.0);
    expect(ins[IDX.impressions]).toBe(460);
  });

  test("keeps match types apart instead of letting one overwrite the other", async () => {
    const rows = [
      { searchTerm: "campingstuhl faltbar", date: "2026-09-06", campaignId: 1, adGroupId: 10, keywordId: 100, keyword: "campingstuhl", matchType: "BROAD", clicks: 5, cost: 3 },
      { searchTerm: "campingstuhl faltbar", date: "2026-09-06", campaignId: 1, adGroupId: 10, keywordId: 200, keyword: "campingstuhl faltbar", matchType: "EXACT", clicks: 1, cost: 1 },
    ];

    const n = await ingestSearchTermData({ workspaceId: WS, profileDbId: PROF, rows, startDate: "2026-09-06", endDate: "2026-09-06" });

    expect(n).toBe(2);
    const byMatch = Object.fromEntries(inserts().map(i => [i[IDX.matchType], i[IDX.clicks]]));
    expect(byMatch).toEqual({ BROAD: 5, EXACT: 1 });
    // Two writes only stay two rows if the upsert key carries the match type (migration 050);
    // under the old key both landed on one slot and the second overwrote the first.
    const sql = dbQuery.mock.calls.find(c => /INSERT INTO search_term_metrics/.test(c[0]))[0];
    expect(sql).toMatch(/ON CONFLICT[\s\S]*COALESCE\(match_type/);
  });

  test("keeps ad groups apart — an ad-group negative only blocks its own ad group", async () => {
    const rows = [
      { searchTerm: "angelstuhl", date: "2026-09-06", campaignId: 1, adGroupId: 10, keywordId: 100, keyword: "stuhl", matchType: "BROAD", clicks: 4, cost: 2 },
      { searchTerm: "angelstuhl", date: "2026-09-06", campaignId: 1, adGroupId: 11, keywordId: 101, keyword: "stuhl", matchType: "BROAD", clicks: 7, cost: 5 },
    ];

    const n = await ingestSearchTermData({ workspaceId: WS, profileDbId: PROF, rows, startDate: "2026-09-06", endDate: "2026-09-06" });

    expect(n).toBe(2);
    const byAdGroup = Object.fromEntries(inserts().map(i => [i[IDX.amazonAdGroup], i[IDX.clicks]]));
    expect(byAdGroup).toEqual({ 10: 4, 11: 7 });
    // Likewise: the ad group has to be part of the upsert key, or the two ad groups collapse
    // into one row and the rule sees a single ad group's traffic for the whole campaign.
    const sql = dbQuery.mock.calls.find(c => /INSERT INTO search_term_metrics/.test(c[0]))[0];
    expect(sql).toMatch(/ON CONFLICT[\s\S]*COALESCE\(ad_group_id/);
  });

  test("keeps days apart", async () => {
    const rows = [
      { searchTerm: "gaskartusche", date: "2026-09-05", campaignId: 1, adGroupId: 10, keywordId: 100, keyword: "gas", matchType: "BROAD", clicks: 2, cost: 1 },
      { searchTerm: "gaskartusche", date: "2026-09-06", campaignId: 1, adGroupId: 10, keywordId: 100, keyword: "gas", matchType: "BROAD", clicks: 3, cost: 2 },
    ];

    await ingestSearchTermData({ workspaceId: WS, profileDbId: PROF, rows, startDate: "2026-09-05", endDate: "2026-09-06" });

    const byDate = Object.fromEntries(inserts().map(i => [i[IDX.dateStart], i[IDX.clicks]]));
    expect(byDate).toEqual({ "2026-09-05": 2, "2026-09-06": 3 });
  });

  test("re-ingesting the same report reproduces the same sums (idempotent)", async () => {
    const rows = [
      { searchTerm: "keilkissen bett", date: "2026-09-06", campaignId: 1, adGroupId: 10, keywordId: 100, keyword: "keilkissen", matchType: "BROAD", clicks: 6, cost: 4.5 },
      { searchTerm: "keilkissen bett", date: "2026-09-06", campaignId: 1, adGroupId: 10, keywordId: 101, keyword: "keilkissen", matchType: "BROAD", clicks: 4, cost: 2.5 },
    ];

    await ingestSearchTermData({ workspaceId: WS, profileDbId: PROF, rows, startDate: "2026-09-06", endDate: "2026-09-06" });
    const first = inserts()[0][IDX.clicks];
    jest.clearAllMocks();
    resolveLookups();
    await ingestSearchTermData({ workspaceId: WS, profileDbId: PROF, rows, startDate: "2026-09-06", endDate: "2026-09-06" });

    expect(inserts()[0][IDX.clicks]).toBe(first);
    expect(first).toBe(10);
  });

  test("SB rows (no window suffix) fall back to purchases/sales and use keywordText", async () => {
    const rows = [
      { searchTerm: "wohnmobil plane", date: "2026-09-06", campaignId: 2, adGroupId: 20, keywordId: 300, keywordText: "plane", matchType: "PHRASE", clicks: 3, cost: 2, purchases: 1, sales: 40 },
    ];

    await ingestSearchTermData({ workspaceId: WS, profileDbId: PROF, rows, startDate: "2026-09-06", endDate: "2026-09-06" });

    const [ins] = inserts();
    expect(ins[IDX.keywordText]).toBe("plane");
    expect(ins[IDX.orders]).toBe(1);
    expect(ins[IDX.sales]).toBe(40);
  });

  test("rows without a search term are skipped, not written", async () => {
    const rows = [
      { date: "2026-09-06", campaignId: 1, adGroupId: 10, clicks: 9 },
      { searchTerm: "echter term", date: "2026-09-06", campaignId: 1, adGroupId: 10, keyword: "k", matchType: "EXACT", clicks: 1 },
    ];

    const n = await ingestSearchTermData({ workspaceId: WS, profileDbId: PROF, rows, startDate: "2026-09-06", endDate: "2026-09-06" });

    expect(n).toBe(1);
    expect(inserts()[0][IDX.query]).toBe("echter term");
  });

  test("campaign-less rows still upsert on the null-campaign index", async () => {
    const rows = [
      { searchTerm: "orphan term", date: "2026-09-06", keyword: "k", matchType: "EXACT", clicks: 2 },
      { searchTerm: "orphan term", date: "2026-09-06", keyword: "k", matchType: "EXACT", clicks: 3 },
    ];

    const n = await ingestSearchTermData({ workspaceId: WS, profileDbId: PROF, rows, startDate: "2026-09-06", endDate: "2026-09-06" });

    expect(n).toBe(1);
    const call = dbQuery.mock.calls.find(c => /INSERT INTO search_term_metrics/.test(c[0]));
    expect(call[0]).toMatch(/WHERE campaign_id IS NULL/);
    expect(call[1][IDX.clicks]).toBe(5);
  });
});
