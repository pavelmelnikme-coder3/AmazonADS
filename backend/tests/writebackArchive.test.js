"use strict";
/**
 * archiveNegativeKeyword / archiveNegativeTarget — Amazon 207 Multi-Status handling
 *
 * Amazon's batch endpoints answer 207: the HTTP call succeeds while individual items are
 * rejected inside the body. adsClient returns any 2xx body without throwing, so an archive
 * that Amazon refused used to be reported as `{ ok: true }` and the audit trail recorded
 * "success" for a change that never happened.
 */

jest.mock("../src/db/pool", () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock("../src/services/amazon/adsClient", () => ({
  get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), getAll: jest.fn(),
}));

const { query: dbQuery } = require("../src/db/pool");
const { put } = require("../src/services/amazon/adsClient");
const { archiveNegativeKeyword, archiveNegativeTarget } =
  require("../src/services/amazon/writeback");

const KW_ARGS = {
  localId: "nk-001",
  connectionId: "conn-001",
  profileId: "12345",
  marketplaceId: "A1PA6795UKMFR9",
  campaignType: "sponsoredProducts",
  level: "ad_group",
  amazonNegKeywordId: "AZ_NEG_001",
};

const TGT_ARGS = {
  localId: "nt-001",
  connectionId: "conn-001",
  profileId: "12345",
  marketplaceId: "A1PA6795UKMFR9",
  campaignType: "sponsoredProducts",
  amazonNegTargetId: "AZ_NEGT_001",
};

beforeEach(() => {
  jest.clearAllMocks();
  dbQuery.mockResolvedValue({ rows: [] });
});

describe("archiveNegativeKeyword", () => {
  it("reports success and archives locally when Amazon accepts", async () => {
    put.mockResolvedValueOnce({ negativeKeywords: { success: [{ keywordId: "AZ_NEG_001" }], error: [] } });
    const res = await archiveNegativeKeyword(KW_ARGS);
    expect(res.ok).toBe(true);
    expect(dbQuery).toHaveBeenCalledWith(
      "UPDATE negative_keywords SET state='archived' WHERE id=$1", ["nk-001"]);
  });

  it("reports failure when the 207 body carries a per-item rejection", async () => {
    put.mockResolvedValueOnce({
      negativeKeywords: { success: [], error: [{ description: "Invalid state transition", index: 0 }] },
    });
    const res = await archiveNegativeKeyword(KW_ARGS);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Invalid state transition/);
  });

  it("does NOT mark the row archived locally when Amazon rejected the change", async () => {
    // Local state must not claim an archive Amazon refused — that divergence is invisible
    // until the next sync silently flips the row back.
    put.mockResolvedValueOnce({
      negativeKeywords: { success: [], error: [{ description: "rejected" }] },
    });
    await archiveNegativeKeyword(KW_ARGS);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("falls back to `message` then to the raw item when no description is present", async () => {
    put.mockResolvedValueOnce({ negativeKeywords: { error: [{ message: "boom" }] } });
    expect((await archiveNegativeKeyword(KW_ARGS)).error).toBe("boom");

    put.mockResolvedValueOnce({ negativeKeywords: { error: [{ code: "X1" }] } });
    expect((await archiveNegativeKeyword(KW_ARGS)).error).toContain("X1");
  });

  it("treats an empty error array as success", async () => {
    put.mockResolvedValueOnce({ negativeKeywords: { success: [{}], error: [] } });
    expect((await archiveNegativeKeyword(KW_ARGS)).ok).toBe(true);
  });

  it("still reports failure when the HTTP call itself throws", async () => {
    put.mockRejectedValueOnce(new Error("network down"));
    const res = await archiveNegativeKeyword(KW_ARGS);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("network down");
  });

  it("refuses to call Amazon without the ids it needs", async () => {
    const res = await archiveNegativeKeyword({ ...KW_ARGS, amazonNegKeywordId: null });
    expect(res.ok).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });

  it("reads errors from the campaign-level key when level = campaign", async () => {
    put.mockResolvedValueOnce({
      campaignNegativeKeywords: { error: [{ description: "campaign-level rejected" }] },
    });
    const res = await archiveNegativeKeyword({ ...KW_ARGS, level: "campaign" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/campaign-level rejected/);
  });
});

describe("archiveNegativeTarget", () => {
  it("reports success when Amazon accepts", async () => {
    put.mockResolvedValueOnce({ negativeTargetingClauses: { success: [{}], error: [] } });
    const res = await archiveNegativeTarget(TGT_ARGS);
    expect(res.ok).toBe(true);
    expect(dbQuery).toHaveBeenCalledWith(
      "UPDATE negative_targets SET state='archived' WHERE id=$1", ["nt-001"]);
  });

  it("reports failure when the 207 body carries a per-item rejection", async () => {
    put.mockResolvedValueOnce({
      negativeTargetingClauses: { success: [], error: [{ description: "target rejected" }] },
    });
    const res = await archiveNegativeTarget(TGT_ARGS);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/target rejected/);
    expect(dbQuery).not.toHaveBeenCalled();
  });
});
