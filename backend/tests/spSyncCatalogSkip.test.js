"use strict";
/**
 * Catalog probing: don't re-ask Amazon about listings it has already said are gone.
 *
 * On 2026-09-08 the workspace tracked 553 ASINs, 276 of which had never returned a
 * BSR since being added in April/May: they are ad rows for listings that no longer
 * exist in the home marketplace. The 4-hourly BSR job and the daily listing-health
 * job asked about all of them anyway, which burned half the shared Catalog Items
 * quota and wrote ~1400 warn lines a day — enough noise to hide a real failure.
 *
 * The weekly cross-country sweep already records that verdict per (ASIN,
 * marketplace), so these two jobs read it instead of rediscovering it six times a
 * day. The verdict is only honoured while it is fresh, so a relisted ASIN comes
 * back on its own and a workspace that never ran a sweep loses nothing.
 */

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock("../src/services/amazon/spClient", () => ({
  getCatalogItem: jest.fn(), getListingContent: jest.fn(), getAplusStatus: jest.fn(),
  getInventory: jest.fn(), getOrders: jest.fn(), getOrderItems: jest.fn(),
  getFinancialEvents: jest.fn(), getCompetitivePricing: jest.fn(),
}));

const pool = require("../src/db/pool");
const logger = require("../src/config/logger");
const spClient = require("../src/services/amazon/spClient");
const { _catalogTargets, syncBsr, syncFinancials } = require("../src/services/amazon/spSync");

const WS = "ws-1";
const MKT = "A1PA6795UKMFR9";

beforeEach(() => jest.clearAllMocks());

describe("_catalogTargets", () => {
  it("splits products into those worth probing and those Amazon already denied", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: "1", asin: "B00LIVE0001", known_missing: false },
        { id: "2", asin: "B00DEAD0001", known_missing: true },
        { id: "3", asin: "B00DEAD0002", known_missing: true },
      ],
    });
    const { products, skipped } = await _catalogTargets(WS, MKT);
    expect(products.map(p => p.asin)).toEqual(["B00LIVE0001"]);
    expect(skipped).toBe(2);
  });

  it("only trusts a verdict that says missing — an unchecked ASIN is still probed", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await _catalogTargets(WS, MKT);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/exists_in_catalog\s*=\s*false/);
    expect(sql).toMatch(/LEFT JOIN/i);
  });

  it("ages the verdict out, so a relisted ASIN is probed again", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await _catalogTargets(WS, MKT);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/checked_at\s*>\s*NOW\(\) - \(\$3/);
    expect(params[2]).toBeGreaterThan(0);
  });

  it("still only looks at products being tracked in that marketplace", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await _catalogTargets(WS, MKT);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/p\.is_active = true/);
    expect(params.slice(0, 2)).toEqual([WS, MKT]);
  });
});

describe("syncBsr", () => {
  // _startLog → _catalogTargets → (per product: update + insert) → _finishLog
  const startLog = () => pool.query.mockResolvedValueOnce({ rows: [{ id: "log-1" }] });

  it("asks Amazon only about the ASINs it has not already been told are gone", async () => {
    startLog();
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: "1", asin: "B00LIVE0001", known_missing: false },
        { id: "2", asin: "B00DEAD0001", known_missing: true },
      ],
    });
    pool.query.mockResolvedValue({ rows: [] });
    spClient.getCatalogItem.mockResolvedValue({
      title: "t", brand: "b", imageUrl: null, parentAsin: null,
      classificationRanks: [{ rank: 12, title: "Cat" }], displayGroupRanks: [], rawData: {},
    });

    const res = await syncBsr(WS, MKT, "token");

    expect(spClient.getCatalogItem).toHaveBeenCalledTimes(1);
    expect(spClient.getCatalogItem).toHaveBeenCalledWith("B00LIVE0001", MKT, "token");
    expect(res.upserted).toBe(1);
  });

  it("reports a 404 sweep once with a count, not once per ASIN", async () => {
    startLog();
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: "1", asin: "B00GONE0001", known_missing: false },
        { id: "2", asin: "B00GONE0002", known_missing: false },
      ],
    });
    pool.query.mockResolvedValue({ rows: [] });
    const notFound = Object.assign(new Error("SP-API 404 NOT_FOUND"), { status: 404, spCode: "NOT_FOUND" });
    spClient.getCatalogItem.mockRejectedValue(notFound);

    const res = await syncBsr(WS, MKT, "token");

    expect(res.notFound).toBe(2);
    const summaries = logger.warn.mock.calls.filter(([msg]) => /not in this marketplace's catalog/.test(msg));
    expect(summaries).toHaveLength(1);
    expect(summaries[0][1]).toMatchObject({ count: 2 });
    // The per-ASIN line is what used to flood the log; it must not come back.
    expect(logger.warn.mock.calls.some(([msg]) => /BSR sync failed for ASIN/.test(msg))).toBe(false);
  });

  it("still names a genuine failure per ASIN — only NOT_FOUND is bulk news", async () => {
    startLog();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "1", asin: "B00LIVE0001", known_missing: false }] });
    pool.query.mockResolvedValue({ rows: [] });
    spClient.getCatalogItem.mockRejectedValue(Object.assign(new Error("SP-API 500 boom"), { status: 500 }));

    await syncBsr(WS, MKT, "token");

    expect(logger.warn.mock.calls.some(([msg]) => /BSR sync failed for ASIN B00LIVE0001/.test(msg))).toBe(true);
  });
});

describe("syncFinancials", () => {
  it("records a missing SP-API role as skipped, not as a failure to retry", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: "log-1" }] });   // _startLog
    pool.query.mockResolvedValueOnce({ rows: [{ last: null }] });    // last posted_date
    pool.query.mockResolvedValue({ rows: [] });                      // _finishLog
    spClient.getFinancialEvents.mockRejectedValue(
      Object.assign(new Error("SP-API 403 Unauthorized: Access to requested resource is denied."), { status: 403 })
    );

    const res = await syncFinancials(WS, MKT, "token");

    expect(res).toMatchObject({ skipped: true });
    const finish = pool.query.mock.calls.find(([sql]) => /UPDATE sp_sync_log SET status=\$1/.test(sql));
    expect(finish[1][0]).toBe("skipped");
    expect(finish[1][3]).toMatch(/Finances role/i);
  });

  it("still fails loudly on anything that is not a permissions verdict", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: "log-1" }] });
    pool.query.mockResolvedValueOnce({ rows: [{ last: null }] });
    pool.query.mockResolvedValue({ rows: [] });
    spClient.getFinancialEvents.mockRejectedValue(
      Object.assign(new Error("SP-API 500 InternalFailure"), { status: 500 })
    );

    await expect(syncFinancials(WS, MKT, "token")).rejects.toThrow(/InternalFailure/);
    const finish = pool.query.mock.calls.find(([sql]) => /UPDATE sp_sync_log SET status=\$1/.test(sql));
    expect(finish[1][0]).toBe("failed");
  });
});
