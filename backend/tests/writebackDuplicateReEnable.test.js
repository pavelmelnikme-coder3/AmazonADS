"use strict";
/**
 * Duplicate-negative recovery — the re-enable PUT is the write-back, so its result counts.
 *
 * When a negative already exists on Amazon, the create is rejected as a duplicate and the
 * recovery path re-enables the existing (PAUSED) negative instead. That PUT *is* the change
 * that makes the negative block traffic again, but its result went unchecked: a thrown error
 * was swallowed by `.catch(logger.warn)` and a 207 per-item rejection never surfaced at all,
 * since Amazon's batch endpoints report those inside a 2xx body.
 *
 * Reporting `ok` for a refused re-enable is the worst possible outcome: the local row is left
 * `enabled` while Amazon keeps the negative PAUSED, and every later rule run then skips the
 * term as `already_negative` — so the term keeps spending behind a negative that blocks
 * nothing, and nothing anywhere reports a failure.
 */

jest.mock("../src/db/pool", () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock("../src/services/amazon/adsClient", () => ({
  get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), getAll: jest.fn(),
}));

const { post, put } = require("../src/services/amazon/adsClient");
const { pushNegativeKeyword, pushNegativeTarget } =
  require("../src/services/amazon/writeback");

const KW_ARGS = {
  localId: "nk-001",
  connectionId: "conn-001",
  profileId: "12345",
  marketplaceId: "A1PA6795UKMFR9",
  campaignType: "sponsoredProducts",
  amazonCampaignId: "C1",
  amazonAdGroupId: "AG1",
  keywordText: "campingstuhl kompakt",
  matchType: "negativeExact",
  level: "ad_group",
};

const TGT_ARGS = {
  localId: "nt-001",
  connectionId: "conn-001",
  profileId: "12345",
  marketplaceId: "A1PA6795UKMFR9",
  campaignType: "sponsoredProducts",
  amazonCampaignId: "C1",
  amazonAdGroupId: "AG1",
  asinValue: "B0C9MGL2BQ",
};

// The create is refused as a duplicate, then the /list lookup finds the existing negative
// in the given state.
function amazonHoldsNegativeKeyword(state) {
  post
    .mockResolvedValueOnce({ negativeKeywords: { error: [{ description: "duplicateValueError" }] } })
    .mockResolvedValueOnce({
      negativeKeywords: [{
        keywordId: "AZ_NEG_001", campaignId: "C1", adGroupId: "AG1",
        keywordText: "campingstuhl kompakt", matchType: "NEGATIVE_EXACT", state,
      }],
    });
}

function amazonHoldsNegativeTarget(state) {
  post
    .mockResolvedValueOnce({ negativeTargetingClauses: { error: [{ description: "duplicateValueError" }] } })
    .mockResolvedValueOnce({
      negativeTargetingClauses: [{
        targetId: "AZ_NEGT_001", campaignId: "C1", adGroupId: "AG1",
        expression: [{ type: "ASIN_SAME_AS", value: "B0C9MGL2BQ" }], state,
      }],
    });
}

beforeEach(() => jest.clearAllMocks());

describe("recoverDuplicateNegativeKeyword", () => {
  it("re-enables a PAUSED duplicate and reports success when Amazon accepts", async () => {
    amazonHoldsNegativeKeyword("PAUSED");
    put.mockResolvedValueOnce({ negativeKeywords: { success: [{ keywordId: "AZ_NEG_001" }], error: [] } });

    const res = await pushNegativeKeyword(KW_ARGS);

    expect(res).toMatchObject({ ok: true, duplicate: true, realId: "AZ_NEG_001" });
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      path: "/sp/negativeKeywords",
      data: { negativeKeywords: [{ keywordId: "AZ_NEG_001", state: "ENABLED" }] },
    }));
  });

  it("reports failure when the 207 body rejects the re-enable", async () => {
    amazonHoldsNegativeKeyword("PAUSED");
    put.mockResolvedValueOnce({
      negativeKeywords: { success: [], error: [{ description: "ENTITY_NOT_FOUND" }] },
    });

    const res = await pushNegativeKeyword(KW_ARGS);

    expect(res.ok).toBe(false);
    expect(res.error).toBe("ENTITY_NOT_FOUND");
  });

  it("reports failure when the re-enable call itself throws", async () => {
    amazonHoldsNegativeKeyword("PAUSED");
    put.mockRejectedValueOnce(new Error("429 Too Many Requests"));

    const res = await pushNegativeKeyword(KW_ARGS);

    expect(res.ok).toBe(false);
    expect(res.error).toBe("429 Too Many Requests");
  });

  it("skips the re-enable entirely when the duplicate is already ENABLED", async () => {
    amazonHoldsNegativeKeyword("ENABLED");

    const res = await pushNegativeKeyword(KW_ARGS);

    expect(res).toMatchObject({ ok: true, duplicate: true });
    expect(put).not.toHaveBeenCalled();
  });
});

describe("recoverDuplicateNegativeTarget", () => {
  it("re-enables a PAUSED duplicate and reports success when Amazon accepts", async () => {
    amazonHoldsNegativeTarget("PAUSED");
    put.mockResolvedValueOnce({ negativeTargetingClauses: { success: [{ targetId: "AZ_NEGT_001" }], error: [] } });

    const res = await pushNegativeTarget(TGT_ARGS);

    expect(res).toMatchObject({ ok: true, duplicate: true, realId: "AZ_NEGT_001" });
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      path: "/sp/negativeTargets",
      data: { negativeTargetingClauses: [{ targetId: "AZ_NEGT_001", state: "ENABLED" }] },
    }));
  });

  it("reports failure when the 207 body rejects the re-enable", async () => {
    amazonHoldsNegativeTarget("PAUSED");
    put.mockResolvedValueOnce({
      negativeTargetingClauses: { success: [], error: [{ description: "ENTITY_NOT_FOUND" }] },
    });

    const res = await pushNegativeTarget(TGT_ARGS);

    expect(res.ok).toBe(false);
    expect(res.error).toBe("ENTITY_NOT_FOUND");
  });
});
