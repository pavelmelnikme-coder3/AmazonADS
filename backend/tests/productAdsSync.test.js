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
const { syncProductAds, expandSbAdsToProductAds } = require("../src/services/amazon/entities");

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

describe("expandSbAdsToProductAds", () => {
  const ad = (over = {}) => ({
    adId: "700",
    adGroupId: "800",
    campaignId: "900",
    state: "ENABLED",
    creative: { asins: ["B0AAAAAAAA", "B0BBBBBBBB"], creativeStatus: "PUBLISHED", type: "PRODUCT_COLLECTION" },
    extendedData: { servingStatus: "AD_STATUS_LIVE", servingStatusDetails: [] },
    ...over,
  });

  it("turns one SB ad into one row per creative ASIN", () => {
    const rows = expandSbAdsToProductAds([ad()]);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.asin)).toEqual(["B0AAAAAAAA", "B0BBBBBBBB"]);
    expect(rows.every(r => r.campaignId === "900" && r.adGroupId === "800")).toBe(true);
    // SB creatives reference ASINs, never SKUs
    expect(rows.every(r => r.sku === null)).toBe(true);
    expect(rows.every(r => r.adType === "sponsoredBrands")).toBe(true);
  });

  it("keys rows so they can never collide with a numeric SP/SD ad id", () => {
    const [row] = expandSbAdsToProductAds([ad()]);
    expect(row.adId).toBe("sb:700:B0AAAAAAAA");
  });

  it("falls back to the ad group when Amazon omits adId on an older ad", () => {
    const [row] = expandSbAdsToProductAds([ad({ adId: undefined })]);
    expect(row.adId).toBe("sb:800:B0AAAAAAAA");
    expect(row.sbAdId).toBeNull();
  });

  it("carries the fields that decide whether the ad can actually show", () => {
    const [row] = expandSbAdsToProductAds([ad({
      creative: { asins: ["B0AAAAAAAA"], creativeStatus: "REJECTED_BY_MODERATION", type: "VIDEO" },
      extendedData: { servingStatus: "AD_POLICING_SUSPENDED" },
    })]);
    expect(row.creative.creativeStatus).toBe("REJECTED_BY_MODERATION");
    expect(row.extendedData.servingStatus).toBe("AD_POLICING_SUSPENDED");
    // state stays whatever Amazon says — an ad can be ENABLED and still blocked
    expect(row.state).toBe("ENABLED");
  });

  it("skips ads with no ASINs and no usable key instead of writing junk rows", () => {
    expect(expandSbAdsToProductAds([
      ad({ creative: { asins: [] } }),
      ad({ adId: undefined, adGroupId: undefined }),
      ad({ creative: { asins: [null, ""] } }),
    ])).toEqual([]);
  });

  it("uppercases ASINs so they match the products table", () => {
    const [row] = expandSbAdsToProductAds([ad({ creative: { asins: ["b0aaaaaaaa"] } })]);
    expect(row.asin).toBe("B0AAAAAAAA");
  });
});
