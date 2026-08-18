"use strict";
/**
 * pushCampaignUpdates / campaignBudgetFields — SP v3 budget shape + 207 handling
 *
 * Regression cover for the silent no-op found on 2026-08-10: the campaign budget was sent as
 * the v2-style flat `dailyBudget`, which is not a field in the SP v3 campaign schema. Amazon
 * ignores the unknown field and still answers 207 with the campaign in `success[]`, so the
 * rule engine recorded 29 consecutive "successful" +20% budget raises while the budget on
 * Amazon never moved. Verified against the live API: `dailyBudget` leaves the budget
 * unchanged, the nested `budget` object applies it.
 */

jest.mock("../src/db/pool", () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock("../src/services/amazon/adsClient", () => ({
  get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), getAll: jest.fn(),
}));

const { put } = require("../src/services/amazon/adsClient");
const {
  pushCampaignUpdates, pushAdGroupUpdates, campaignBudgetFields, wrapCampaigns, campaignApiPath,
} = require("../src/services/amazon/writeback");

const BASE = {
  amazonCampaignId: "AZ_CAMP_001",
  connectionId: "conn-001",
  profileId: "12345",
  marketplaceId: "A1PA6795UKMFR9",
};

beforeEach(() => {
  jest.clearAllMocks();
  put.mockResolvedValue({ campaigns: { success: [{ campaignId: "AZ_CAMP_001", index: 0 }], error: [] } });
});

// ─── campaignBudgetFields ────────────────────────────────────────────────────
describe("campaignBudgetFields", () => {
  it("nests the budget for SP — never emits the v2 dailyBudget field", () => {
    const fields = campaignBudgetFields("sponsoredProducts", 42);
    expect(fields).toEqual({ budget: { budget: 42, budgetType: "DAILY" } });
    expect(fields.dailyBudget).toBeUndefined();
  });

  // SB v4 is flat, like SD but with an uppercase budgetType. Read off what Amazon actually
  // returns for a live SB campaign (stored raw_data):
  //   {"budget": 20, "budgetType": "DAILY", "campaignId": "439113387587087", ...}
  // Sending SP's nested object here would have been the same silent no-op that hid the SP
  // budget bug for a month — once the 406 stopped hiding it first.
  it("keeps SB v4 flat, with an uppercase budgetType", () => {
    const fields = campaignBudgetFields("sponsoredBrands", 60);
    expect(fields).toEqual({ budget: 60, budgetType: "DAILY" });
    expect(fields.budget).not.toEqual(expect.objectContaining({ budgetType: "DAILY" }));
    expect(fields.dailyBudget).toBeUndefined();
  });

  it("keeps SD flat and lowercase (its PUT is still v2-style)", () => {
    expect(campaignBudgetFields("sponsoredDisplay", 40))
      .toEqual({ budget: 40, budgetType: "daily" });
  });

  it("coerces numeric strings and ignores unparseable values", () => {
    expect(campaignBudgetFields("sponsoredProducts", "25.50"))
      .toEqual({ budget: { budget: 25.5, budgetType: "DAILY" } });
    expect(campaignBudgetFields("sponsoredProducts", "not-a-number")).toEqual({});
  });
});

// ─── campaignApiPath ─────────────────────────────────────────────────────────
// One definition, because this map was copy-pasted at five call sites and every copy sent SB
// to the v3 /sb/campaigns route Amazon removed — so SB budget raises and SB state changes from
// the campaign edit form both answered 406 "No match for accept header".
describe("campaignApiPath", () => {
  it("points SB at the v4 route, not the removed v3 one", () => {
    expect(campaignApiPath("sponsoredBrands")).toBe("/sb/v4/campaigns");
  });

  it("leaves SP and SD where they are", () => {
    expect(campaignApiPath("sponsoredProducts")).toBe("/sp/campaigns");
    expect(campaignApiPath("sponsoredDisplay")).toBe("/sd/campaigns");
  });

  it("returns undefined for an unknown type so callers can refuse to guess", () => {
    expect(campaignApiPath("sponsoredSomething")).toBeUndefined();
    expect(campaignApiPath(undefined)).toBeUndefined();
  });
});

// ─── wrapCampaigns ───────────────────────────────────────────────────────────
describe("wrapCampaigns", () => {
  it("wraps SP/SB in { campaigns: [...] }", () => {
    expect(wrapCampaigns("sponsoredProducts", [{ a: 1 }])).toEqual({ campaigns: [{ a: 1 }] });
    expect(wrapCampaigns("sponsoredBrands", [{ a: 1 }])).toEqual({ campaigns: [{ a: 1 }] });
  });

  it("leaves SD as a bare array", () => {
    expect(wrapCampaigns("sponsoredDisplay", [{ a: 1 }])).toEqual([{ a: 1 }]);
  });
});

// ─── pushCampaignUpdates ─────────────────────────────────────────────────────
describe("pushCampaignUpdates", () => {
  it("sends SP budget as the nested v3 object", async () => {
    const res = await pushCampaignUpdates([
      { ...BASE, campaignType: "sponsoredProducts", dailyBudget: 18 },
    ]);
    expect(res).toEqual({ ok: true });
    const { path, data } = put.mock.calls[0][0];
    expect(path).toBe("/sp/campaigns");
    expect(data).toEqual({
      campaigns: [{ campaignId: "AZ_CAMP_001", budget: { budget: 18, budgetType: "DAILY" } }],
    });
    expect(data.campaigns[0].dailyBudget).toBeUndefined();
  });

  it("sends SD budget flat, as a bare array", async () => {
    await pushCampaignUpdates([{ ...BASE, campaignType: "sponsoredDisplay", dailyBudget: 30 }]);
    const { path, data } = put.mock.calls[0][0];
    expect(path).toBe("/sd/campaigns");
    expect(data).toEqual([{ campaignId: "AZ_CAMP_001", budget: 30, budgetType: "daily" }]);
  });

  it("uppercases state for SP/SB and lowercases it for SD", async () => {
    await pushCampaignUpdates([{ ...BASE, campaignType: "sponsoredProducts", state: "paused" }]);
    expect(put.mock.calls[0][0].data.campaigns[0].state).toBe("PAUSED");

    put.mockClear();
    await pushCampaignUpdates([{ ...BASE, campaignType: "sponsoredDisplay", state: "paused" }]);
    expect(put.mock.calls[0][0].data[0].state).toBe("paused");
  });

  it("sends state and budget together in one campaign object", async () => {
    await pushCampaignUpdates([
      { ...BASE, campaignType: "sponsoredProducts", state: "enabled", dailyBudget: 12 },
    ]);
    expect(put.mock.calls[0][0].data.campaigns[0]).toEqual({
      campaignId: "AZ_CAMP_001",
      state: "ENABLED",
      budget: { budget: 12, budgetType: "DAILY" },
    });
  });

  // The core regression: a 207 body reporting a per-item rejection must not read as success.
  it("reports a 207 partial rejection as an error", async () => {
    put.mockResolvedValue({
      campaigns: { success: [], error: [{ index: 0, description: "BUDGET_BELOW_MINIMUM" }] },
    });
    const res = await pushCampaignUpdates([
      { ...BASE, campaignType: "sponsoredProducts", dailyBudget: 0.5 },
    ]);
    expect(res).toEqual({ ok: false, error: "BUDGET_BELOW_MINIMUM" });
  });

  it("reports a thrown transport error without propagating it", async () => {
    put.mockRejectedValue(new Error("connection reset"));
    const res = await pushCampaignUpdates([
      { ...BASE, campaignType: "sponsoredProducts", dailyBudget: 18 },
    ]);
    expect(res).toEqual({ ok: false, error: "connection reset" });
  });

  it("splits calls per campaign type and per profile", async () => {
    await pushCampaignUpdates([
      { ...BASE, campaignType: "sponsoredProducts", dailyBudget: 10 },
      { ...BASE, amazonCampaignId: "AZ_CAMP_002", campaignType: "sponsoredBrands", dailyBudget: 20 },
      { ...BASE, amazonCampaignId: "AZ_CAMP_003", profileId: "99999", campaignType: "sponsoredProducts", dailyBudget: 30 },
    ]);
    const paths = put.mock.calls.map(([o]) => o.path).sort();
    expect(paths).toEqual(["/sb/v4/campaigns", "/sp/campaigns", "/sp/campaigns"]);
  });

  it("is a no-op for an empty list", async () => {
    expect(await pushCampaignUpdates([])).toEqual({ ok: true });
    expect(put).not.toHaveBeenCalled();
  });

  it("skips entries with no connection", async () => {
    await pushCampaignUpdates([{ ...BASE, connectionId: null, campaignType: "sponsoredProducts", dailyBudget: 10 }]);
    expect(put).not.toHaveBeenCalled();
  });

  it("flags an unknown campaign type instead of guessing an endpoint", async () => {
    const res = await pushCampaignUpdates([{ ...BASE, campaignType: "sponsoredTelepathy", dailyBudget: 10 }]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/sponsoredTelepathy/);
    expect(put).not.toHaveBeenCalled();
  });
});

// ─── pushAdGroupUpdates ──────────────────────────────────────────────────────
describe("pushAdGroupUpdates", () => {
  const AG = {
    amazonAdGroupId: "AZ_AG_001",
    campaignType: "sponsoredProducts",
    connectionId: "conn-001",
    profileId: "12345",
    marketplaceId: "A1PA6795UKMFR9",
  };

  beforeEach(() => {
    put.mockResolvedValue({ adGroups: { success: [{ adGroupId: "AZ_AG_001" }], error: [] } });
  });

  it("sends defaultBid and uppercased state", async () => {
    const res = await pushAdGroupUpdates([{ ...AG, defaultBid: 0.36, state: "paused" }]);
    expect(res).toEqual({ ok: true });
    const { path, data } = put.mock.calls[0][0];
    expect(path).toBe("/sp/adGroups");
    expect(data).toEqual({ adGroups: [{ adGroupId: "AZ_AG_001", state: "PAUSED", defaultBid: 0.36 }] });
  });

  it("reports a 207 partial rejection as an error", async () => {
    put.mockResolvedValue({ adGroups: { success: [], error: [{ description: "BID_TOO_LOW" }] } });
    expect(await pushAdGroupUpdates([{ ...AG, defaultBid: 0.01 }]))
      .toEqual({ ok: false, error: "BID_TOO_LOW" });
  });

  it("is a no-op for an empty list", async () => {
    expect(await pushAdGroupUpdates([])).toEqual({ ok: true });
    expect(put).not.toHaveBeenCalled();
  });
});
