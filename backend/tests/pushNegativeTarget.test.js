"use strict";
/**
 * pushNegativeTarget — creating a negative targeting clause from an arbitrary expression.
 *
 * The rule engine's `add_negative_target` branch used to inline this as a bare
 * `post(...).then(...)`. Two defects came with that:
 *
 *   • it returned `success` whenever the HTTP call did not throw. Amazon's v3 batch endpoints
 *     answer 207 Multi-Status, so a clause rejected inside the body left `realId` undefined
 *     and the audit row still said "success";
 *   • it was fire-and-forget — not pushed onto `pendingWritebacks` — so executeRule could
 *     return, and the run be marked completed, before Amazon had answered.
 *
 * Routing it through this helper puts it under the same {ok,error} contract, 207 inspection
 * and duplicate recovery as every other write-back.
 */

jest.mock("../src/db/pool", () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock("../src/services/amazon/adsClient", () => ({
  get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), getAll: jest.fn(),
}));

const { query: dbQuery } = require("../src/db/pool");
const { post } = require("../src/services/amazon/adsClient");
const { pushNegativeTarget, pushNegativeAsin } = require("../src/services/amazon/writeback");

const ARGS = {
  localId: "nt-001",
  connectionId: "conn-001",
  profileId: "12345",
  marketplaceId: "A1PA6795UKMFR9",
  campaignType: "sponsoredProducts",
  amazonCampaignId: "AZ_CAMP_1",
  amazonAdGroupId: "AZ_AG_1",
  expression: [{ type: "ASIN_SAME_AS", value: "B01BYABDPU" }],
  level: "ad_group",
};

beforeEach(() => {
  jest.clearAllMocks();
  dbQuery.mockResolvedValue({ rows: [] });
});

describe("pushNegativeTarget", () => {
  it("stores the real Amazon id when the clause is created", async () => {
    post.mockResolvedValueOnce({ negativeTargetingClauses: { success: [{ targetId: "AZ_NT_9" }], error: [] } });
    const res = await pushNegativeTarget(ARGS);
    expect(res.ok).toBe(true);
    expect(dbQuery).toHaveBeenCalledWith(
      "UPDATE negative_targets SET amazon_neg_target_id = $1 WHERE id = $2",
      ["AZ_NT_9", "nt-001"]);
  });

  it("reports failure when the 207 body rejects the clause", async () => {
    // The exact shape the old inline handler read as a success.
    post.mockResolvedValueOnce({
      negativeTargetingClauses: { success: [], error: [{ description: "Invalid expression", index: 0 }] },
    });
    const res = await pushNegativeTarget(ARGS);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Invalid expression");
    expect(dbQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("UPDATE negative_targets SET amazon_neg_target_id"), expect.anything());
  });

  it("reports failure when the response carries neither an id nor an error", async () => {
    post.mockResolvedValueOnce({ negativeTargetingClauses: { success: [], error: [] } });
    const res = await pushNegativeTarget(ARGS);
    expect(res.ok).toBe(false);
  });

  it("reports failure when the request throws", async () => {
    post.mockRejectedValueOnce(new Error("Amazon API error: 401 Unauthorized"));
    const res = await pushNegativeTarget(ARGS);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("401");
  });

  it("refuses to call Amazon without a connection", async () => {
    const res = await pushNegativeTarget({ ...ARGS, connectionId: null });
    expect(res.ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it("sends the caller's expression verbatim, ENABLED, scoped to the ad group", async () => {
    post.mockResolvedValueOnce({ negativeTargetingClauses: { success: [{ targetId: "X" }] } });
    await pushNegativeTarget(ARGS);
    const [{ path, data }] = post.mock.calls[0];
    expect(path).toBe("/sp/negativeTargets");
    expect(data.negativeTargetingClauses[0]).toMatchObject({
      expression: ARGS.expression,
      expressionType: "manual",
      state: "ENABLED",
      campaignId: "AZ_CAMP_1",
      adGroupId: "AZ_AG_1",
    });
  });

  it("routes Sponsored Display to its own endpoint", async () => {
    post.mockResolvedValueOnce({ negativeTargetingClauses: { success: [{ targetId: "X" }] } });
    await pushNegativeTarget({ ...ARGS, campaignType: "sponsoredDisplay" });
    expect(post.mock.calls[0][0].path).toBe("/sd/negativeTargets");
  });

  it("omits adGroupId when there is none, rather than sending null", async () => {
    post.mockResolvedValueOnce({ negativeTargetingClauses: { success: [{ targetId: "X" }] } });
    await pushNegativeTarget({ ...ARGS, amazonAdGroupId: null });
    expect(post.mock.calls[0][0].data.negativeTargetingClauses[0]).not.toHaveProperty("adGroupId");
  });

  it("does not attempt ASIN duplicate-recovery for a non-ASIN expression", async () => {
    // Recovery looks the clause up by ASIN; there is nothing to look up for other shapes,
    // and a second listing pass would just burn quota.
    post.mockResolvedValueOnce({
      negativeTargetingClauses: { success: [], error: [{ description: "duplicateValueError" }] },
    });
    const res = await pushNegativeTarget({ ...ARGS, expression: [{ type: "QUERY_BROAD_REL_MATCHES" }] });
    expect(res.ok).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("pushNegativeAsin", () => {
  it("still builds the ASIN_SAME_AS expression for its callers", async () => {
    post.mockResolvedValueOnce({ negativeTargetingClauses: { success: [{ targetId: "AZ_NT_2" }] } });
    const res = await pushNegativeAsin({
      localId: "nt-002", connectionId: "conn-001", profileId: "12345",
      marketplaceId: "A1PA6795UKMFR9", campaignType: "sponsoredProducts",
      amazonCampaignId: "AZ_CAMP_1", amazonAdGroupId: "AZ_AG_1",
      asinValue: "B0C7GSHLPW", level: "ad_group",
    });
    expect(res.ok).toBe(true);
    expect(post.mock.calls[0][0].data.negativeTargetingClauses[0].expression)
      .toEqual([{ type: "ASIN_SAME_AS", value: "B0C7GSHLPW" }]);
  });

  it("recovers the real id when Amazon says the ASIN negative already exists", async () => {
    post
      .mockResolvedValueOnce({ negativeTargetingClauses: { success: [], error: [{ description: "duplicateValueError" }] } })
      .mockResolvedValueOnce({ negativeTargetingClauses: [{
        targetId: "AZ_NT_EXISTING", campaignId: "AZ_CAMP_1", adGroupId: "AZ_AG_1",
        state: "ENABLED", expression: [{ type: "ASIN_SAME_AS", value: "B0C7GSHLPW" }],
      }] });
    const res = await pushNegativeAsin({
      localId: "nt-003", connectionId: "conn-001", profileId: "12345",
      marketplaceId: "A1PA6795UKMFR9", campaignType: "sponsoredProducts",
      amazonCampaignId: "AZ_CAMP_1", amazonAdGroupId: "AZ_AG_1",
      asinValue: "B0C7GSHLPW", level: "ad_group",
    });
    expect(res.ok).toBe(true);
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE negative_targets SET amazon_neg_target_id"),
      expect.arrayContaining(["AZ_NT_EXISTING"]));
  });
});
