"use strict";
/**
 * negative_targets.state must come from Amazon.
 *
 * syncNegativeTargets used to omit `state` entirely — not in the INSERT column list, not in
 * the ON CONFLICT DO UPDATE — while syncNegativeKeywords has always synced it. So the column
 * held whatever AdsFlow last wrote locally and was never checked against reality, which made
 * every divergence permanent and invisible. Measured on production 2026-09-04:
 *
 *   • 43 ASIN negatives the rules had released (local 'archived') were still ENABLED on
 *     Amazon and blocking traffic the rules had decided should flow;
 *   • 51 rows shown as active here were ARCHIVED on Amazon.
 *
 * Amazon is the authority on whether a negative is live.
 */

jest.mock("../src/db/pool", () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock("../src/services/amazon/adsClient", () => ({
  get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), getAll: jest.fn(),
}));

const { query: dbQuery } = require("../src/db/pool");
const { syncNegativeTargets } = require("../src/services/amazon/entities");

const PROFILE = { id: "prof-1", workspace_id: "ws-1" };

// The two lookup queries syncNegativeTargets runs before its upsert: campaigns, then ad groups.
function primeMaps() {
  dbQuery
    .mockResolvedValueOnce({ rows: [{ id: "camp-1", amazon_campaign_id: "AZ_CAMP_1" }] })
    .mockResolvedValueOnce({ rows: [{ id: "ag-1", amazon_ag_id: "AZ_AG_1" }] })
    .mockResolvedValue({ rows: [] });
}

function upsertCall() {
  return dbQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO negative_targets"));
}

beforeEach(() => {
  jest.clearAllMocks();
  dbQuery.mockResolvedValue({ rows: [] });
});

describe("syncNegativeTargets", () => {
  const target = (over = {}) => ({
    targetId: "AZ_NT_1", campaignId: "AZ_CAMP_1", adGroupId: "AZ_AG_1",
    expression: [{ type: "ASIN_SAME_AS", value: "B01BYABDPU" }],
    expressionType: "manual", state: "ENABLED", ...over,
  });

  it("writes the Amazon state into the row", async () => {
    primeMaps();
    await syncNegativeTargets(PROFILE, [target()], "SP");
    const [sql, params] = upsertCall();
    expect(sql).toContain("state");
    expect(params).toContain("enabled");
  });

  it("lower-cases Amazon's uppercase enum to the local convention", async () => {
    primeMaps();
    await syncNegativeTargets(PROFILE, [target({ state: "ARCHIVED" })], "SP");
    expect(upsertCall()[1]).toContain("archived");
  });

  it("carries a PAUSED negative through — paused means it is no longer blocking", async () => {
    primeMaps();
    await syncNegativeTargets(PROFILE, [target({ state: "PAUSED" })], "SP");
    expect(upsertCall()[1]).toContain("paused");
  });

  it("refreshes state on conflict, so a row already stored is corrected too", async () => {
    primeMaps();
    await syncNegativeTargets(PROFILE, [target()], "SP");
    const [sql] = upsertCall();
    expect(sql).toContain("ON CONFLICT (profile_id, amazon_neg_target_id) DO UPDATE SET");
    expect(sql).toContain("state=EXCLUDED.state");
  });

  it("defaults to enabled when Amazon omits the state", async () => {
    primeMaps();
    await syncNegativeTargets(PROFILE, [target({ state: undefined })], "SP");
    expect(upsertCall()[1]).toContain("enabled");
  });

  it("keeps one placeholder per column — state must not shift the parameter list", async () => {
    primeMaps();
    await syncNegativeTargets(PROFILE, [target()], "SP");
    const [sql, params] = upsertCall();
    const columns = sql.match(/\(workspace_id[^)]*\)/)[0].split(",").length;
    // synced_at is NOW() in the VALUES tuple, so it has no parameter of its own.
    expect(params).toHaveLength(columns - 1);
  });

  it("writes nothing when Amazon returns no targets", async () => {
    primeMaps();
    const n = await syncNegativeTargets(PROFILE, [], "SP");
    expect(n).toBe(0);
    expect(upsertCall()).toBeUndefined();
  });
});
