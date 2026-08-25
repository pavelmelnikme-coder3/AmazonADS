"use strict";
/**
 * syncProductAds — the ASIN → campaign link behind the "which campaigns
 * advertise this product?" panel.
 *
 * The regression guarded here: campaign_id/ad_group_id were missing from the
 * ON CONFLICT update, so an ad first synced while its campaign was still
 * unknown (campaign created between two syncs) stayed orphaned forever.
 */
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { query: dbQuery } = require("../src/db/pool");
const { syncProductAds } = require("../src/services/amazon/entities");

const PROFILE = { id: "prof-1", workspace_id: "ws-1" };

describe("syncProductAds", () => {
  beforeEach(() => jest.clearAllMocks());

  const run = async (ads, { campaigns = [], adGroups = [] } = {}) => {
    dbQuery
      .mockResolvedValueOnce({ rows: campaigns })   // campaign map
      .mockResolvedValueOnce({ rows: adGroups })    // ad group map
      .mockResolvedValueOnce({ rows: [] });         // the upsert
    await syncProductAds(PROFILE, ads);
    return dbQuery.mock.calls[2];
  };

  it("re-links an ad whose campaign only became known on a later sync", async () => {
    const [sql] = await run(
      [{ adId: "1", campaignId: "c1", adGroupId: "g1", asin: "B0FKTRLCPJ", state: "ENABLED" }],
      { campaigns: [{ id: "camp-uuid", amazon_campaign_id: "c1" }],
        adGroups:  [{ id: "ag-uuid",   amazon_ag_id: "g1" }] }
    );
    expect(sql).toMatch(/campaign_id=COALESCE\(EXCLUDED\.campaign_id, product_ads\.campaign_id\)/);
    expect(sql).toMatch(/ad_group_id=COALESCE\(EXCLUDED\.ad_group_id, product_ads\.ad_group_id\)/);
  });

  it("keeps the stored link when this run cannot resolve the campaign", async () => {
    const [sql, params] = await run(
      [{ adId: "1", campaignId: "unknown", adGroupId: "unknown", asin: "B0FKTRLCPJ", state: "ENABLED" }]
    );
    // Unresolved → NULL is sent, and COALESCE makes the update a no-op for that column
    expect(params[2]).toBeNull();
    expect(params[3]).toBeNull();
    expect(sql).toMatch(/COALESCE\(EXCLUDED\.campaign_id, product_ads\.campaign_id\)/);
  });

  it("normalizes Amazon's uppercase state and stores SP and SD ads alike", async () => {
    const [, params] = await run(
      [
        { adId: "1", campaignId: "c1", adGroupId: "g1", asin: "B0AAAAAAAA", sku: "SP-SKU", state: "ENABLED" },
        { adId: "2", campaignId: "c1", adGroupId: "g1", asin: "B0BBBBBBBB", sku: "SD-SKU", state: "enabled" },
      ],
      { campaigns: [{ id: "camp-uuid", amazon_campaign_id: "c1" }],
        adGroups:  [{ id: "ag-uuid",   amazon_ag_id: "g1" }] }
    );
    expect(params).toContain("SP-SKU");
    expect(params).toContain("SD-SKU");
    expect(params.filter(p => p === "enabled")).toHaveLength(2);
    expect(params).not.toContain("ENABLED");
  });
});
