"use strict";
/**
 * Campaign daily-budget ingest — regression suite (2026-08-14)
 *
 * Amazon reports the budget in two different shapes depending on campaign type:
 *   SP (v3)         budget: { budget: 24, budgetType: "DAILY" }
 *   SB / SD (v2)    budget: 10
 *
 * The sync only read `c.budget?.budget`, which is undefined for a plain number, so
 * every SB and SD campaign was stored with a NULL budget — 221 of them on production.
 * That NULL then met `entity.daily_budget || 10` in the budget rule, which treated the
 * campaign as running on €10 and "raised" it to €12; a campaign really on €50 would
 * have been cut by 76% while the audit journal recorded a raise.
 */

const { parseDailyBudget } = require("../src/services/amazon/entities");

describe("parseDailyBudget — the two shapes Amazon actually returns", () => {
  it("reads the nested object SP (v3) returns", () => {
    expect(parseDailyBudget({ budget: { budget: 24, budgetType: "DAILY" } })).toBe(24);
  });

  it("reads the plain number SB and SD return", () => {
    // The exact shape observed on production for sponsoredDisplay:
    // {"budget": 10, "budgetType": "daily", "campaignType": "sponsoredDisplay"}
    expect(parseDailyBudget({ budget: 10, budgetType: "daily" })).toBe(10);
    expect(parseDailyBudget({ budget: 50, budgetType: "daily" })).toBe(50);
  });

  it("keeps a real zero instead of collapsing it to null", () => {
    // 0 is a legitimate budget; `||` chains used to turn it into a fallback.
    expect(parseDailyBudget({ budget: 0 })).toBe(0);
    expect(parseDailyBudget({ budget: { budget: 0 } })).toBe(0);
  });

  it("accepts quoted numerics from v2-style endpoints", () => {
    expect(parseDailyBudget({ budget: "15.50" })).toBe(15.5);
    expect(parseDailyBudget({ budget: { budget: "30" } })).toBe(30);
  });

  it("prefers an explicit dailyBudget when a campaign type ever returns one", () => {
    expect(parseDailyBudget({ dailyBudget: 42, budget: 10 })).toBe(42);
  });

  it("returns null — never a guess — when no budget is present", () => {
    expect(parseDailyBudget({})).toBeNull();
    expect(parseDailyBudget({ budget: null })).toBeNull();
    expect(parseDailyBudget({ budget: {} })).toBeNull();
    expect(parseDailyBudget({ budget: "n/a" })).toBeNull();
  });
});
