"use strict";
/**
 * ingestReportData — pre-aggregation by (amazon_id, date).
 * The advertised-product report returns one row per (campaign/ad group, ASIN, date), so a single
 * ASIN appears in many rows per day. Ingest must SUM them into one upsert (not overwrite), else
 * ~half of per-ASIN ad spend is lost.
 */
jest.mock("../src/db/pool", () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { query: dbQuery } = require("../src/db/pool");
const { ingestReportData } = require("../src/services/amazon/reporting");

const WS = "ws-1", PROF = "prof-1";
// Param indexes in the INSERT values array.
const IDX = { date: 2, level: 3, amazon: 5, cost: 9, sales14: 12, orders14: 16, clicks: 8 };

beforeEach(() => jest.clearAllMocks());

describe("advertised_product aggregation", () => {
  test("sums multiple campaign rows for the same ASIN/date into ONE upsert", async () => {
    const rows = [
      { advertisedAsin: "B099ZVP253", date: "2026-06-20", campaignId: 1, cost: 10, clicks: 5, sales14d: 100, purchases14d: 2 },
      { advertisedAsin: "B099ZVP253", date: "2026-06-20", campaignId: 2, cost: 20, clicks: 8, sales14d: 200, purchases14d: 3 },
      { advertisedAsin: "B099ZVP253", date: "2026-06-20", campaignId: 3, cost: 5,  clicks: 1, sales14d: 0,   purchases14d: 0 },
      { advertisedAsin: "B0OTHER",    date: "2026-06-20", campaignId: 1, cost: 7,  clicks: 2, sales14d: 50,  purchases14d: 1 },
    ];
    const n = await ingestReportData({ reportRequestId: "r1", workspaceId: WS, profileDbId: PROF, reportLevel: "advertised_product", rows, campaignType: "SP" });

    // 2 distinct (ASIN,date) groups → 2 upserts (not 4 rows).
    expect(n).toBe(2);
    const inserts = dbQuery.mock.calls.filter(c => /INSERT INTO fact_metrics_daily/.test(c[0]));
    expect(inserts).toHaveLength(2);
    const b099 = inserts.find(c => c[1][IDX.amazon] === "B099ZVP253")[1];
    expect(b099[IDX.cost]).toBe(35);      // 10+20+5 summed (not overwritten to 5)
    expect(b099[IDX.clicks]).toBe(14);    // 5+8+1
    expect(b099[IDX.sales14]).toBe(300);  // 100+200+0
    expect(b099[IDX.orders14]).toBe(5);   // 2+3+0
  });

  test("SD rows (no window suffix) fall back to sales/purchases", async () => {
    const rows = [{ advertisedAsin: "B0SD", date: "2026-06-20", campaignId: 9, cost: 4, sales: 80, purchases: 2 }];
    await ingestReportData({ reportRequestId: "r2", workspaceId: WS, profileDbId: PROF, reportLevel: "advertised_product", rows, campaignType: "SD" });
    const ins = dbQuery.mock.calls.find(c => /INSERT INTO fact_metrics_daily/.test(c[0]))[1];
    expect(ins[IDX.sales14]).toBe(80);
    expect(ins[IDX.orders14]).toBe(2);
  });

  test("skips rows with no date; a missing ASIN folds into the 'unknown' group", async () => {
    const rows = [
      { advertisedAsin: "", date: "2026-06-20", cost: 5 },   // no ASIN → 'unknown' group
      { advertisedAsin: "B0X", date: null, cost: 5 },         // no date → skipped
      { advertisedAsin: "B0Y", date: "2026-06-20", cost: 9 }, // own group
    ];
    const n = await ingestReportData({ reportRequestId: "r3", workspaceId: WS, profileDbId: PROF, reportLevel: "advertised_product", rows, campaignType: "SP" });
    expect(n).toBe(2); // 'unknown' + B0Y (the null-date row is dropped)
    const ids = dbQuery.mock.calls.filter(c => /INSERT INTO fact_metrics_daily/.test(c[0])).map(c => c[1][IDX.amazon]);
    expect(ids.sort()).toEqual(["B0Y", "unknown"]);
  });
});
