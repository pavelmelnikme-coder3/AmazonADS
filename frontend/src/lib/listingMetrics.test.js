/**
 * Listing-row totals. Both cases reproduce what the Products page showed on 2026-09-11 against
 * what the database actually held.
 */
import { describe, test, expect } from "vitest";
import { listingPeriodOrders, listingCampaignCounts } from "./listingMetrics.js";

describe("listingPeriodOrders", () => {
  const periodOrders = {
    by_asin: {
      A1: { orders: 3 },   // orders #1, #2, #3
      A2: { orders: 2 },   // orders #1, #4
      A3: { orders: 2 },   // orders #2, #5 — hidden by a filter below
    },
    // #1 holds A1+A2, #2 holds A1+A3
    multi_asin_orders: [["A1", "A2"], ["A1", "A3"]],
  };

  test("an order holding two visible variations counts once", () => {
    // 3 + 2 per ASIN, but #1 is shared → 4 distinct orders
    expect(listingPeriodOrders(["A1", "A2"], periodOrders)).toBe(4);
  });

  test("an order shared with a HIDDEN variation is not subtracted", () => {
    // Only A1 visible: #2 is shared with A3, but A3 isn't on screen, so A1's 3 stand.
    expect(listingPeriodOrders(["A1"], periodOrders)).toBe(3);
  });

  test("the whole family counts every order once", () => {
    // #1..#5
    expect(listingPeriodOrders(["A1", "A2", "A3"], periodOrders)).toBe(5);
  });

  test("an order holding three variations counts once", () => {
    const po = { by_asin: { A1: { orders: 1 }, A2: { orders: 1 }, A3: { orders: 1 } },
                 multi_asin_orders: [["A1", "A2", "A3"]] };
    expect(listingPeriodOrders(["A1", "A2", "A3"], po)).toBe(1);
  });

  test("a response without the shared-order list falls back to the plain sum", () => {
    expect(listingPeriodOrders(["A1", "A2"], { by_asin: periodOrders.by_asin })).toBe(5);
  });

  test("no data yet reads as zero", () => {
    expect(listingPeriodOrders(["A1"], null)).toBe(0);
    expect(listingPeriodOrders(["ZZ"], periodOrders)).toBe(0);
  });
});

describe("listingCampaignCounts", () => {
  test("one campaign advertising every variation is one campaign", () => {
    const children = Array.from({ length: 6 }, () => ({ ad_campaign_keys: [7, 8, 9], ad_campaign_live_keys: [7] }));
    expect(listingCampaignCounts(children)).toEqual({ total: 3, live: 1 });
  });

  test("distinct campaigns across variations add up", () => {
    const children = [
      { ad_campaign_keys: [1, 2], ad_campaign_live_keys: [1] },
      { ad_campaign_keys: [2, 3], ad_campaign_live_keys: [3] },
    ];
    expect(listingCampaignCounts(children)).toEqual({ total: 3, live: 2 });
  });

  test("rows without campaign keys count as none", () => {
    expect(listingCampaignCounts([{}, { ad_campaign_keys: null }])).toEqual({ total: 0, live: 0 });
    expect(listingCampaignCounts(undefined)).toEqual({ total: 0, live: 0 });
  });
});
