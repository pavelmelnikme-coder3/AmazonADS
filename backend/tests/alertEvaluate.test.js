"use strict";
/**
 * Alert evaluation engine tests — pure metric helpers + evaluateWorkspaceAlerts.
 */
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../src/services/email", () => ({ sendAlertEmail: jest.fn().mockResolvedValue(undefined) }));

const { query: dbQuery } = require("../src/db/pool");
const { sendAlertEmail } = require("../src/services/email");
const { computeMetric, compare, formatValue, evaluateWorkspaceAlerts, detectMoverCauses, topSpendCampaigns } = require("../src/services/alerts/evaluate");

const WS_ID = "ws---0001-0000-0000-000000000001";

beforeEach(() => jest.clearAllMocks());

describe("computeMetric", () => {
  const agg = { cost: 100, sales: 400, orders: 10, clicks: 50, impressions: 1000 };
  test("acos = cost/sales*100", () => expect(computeMetric("acos", agg)).toBeCloseTo(25));
  test("roas = sales/cost", () => expect(computeMetric("roas", agg)).toBeCloseTo(4));
  test("spend = cost", () => expect(computeMetric("spend", agg)).toBe(100));
  test("sales passthrough", () => expect(computeMetric("sales", agg)).toBe(400));
  test("orders passthrough", () => expect(computeMetric("orders", agg)).toBe(10));
  test("clicks passthrough", () => expect(computeMetric("clicks", agg)).toBe(50));
  test("ctr = clicks/impr*100", () => expect(computeMetric("ctr", agg)).toBeCloseTo(5));
  test("cpc = cost/clicks", () => expect(computeMetric("cpc", agg)).toBeCloseTo(2));
  test("cvr = orders/clicks*100", () => expect(computeMetric("cvr", agg)).toBeCloseTo(20));
  test("impressions passthrough", () => expect(computeMetric("impressions", agg)).toBe(1000));
  test("acos with zero sales but spend → large finite (fires > thresholds)", () => {
    const v = computeMetric("acos", { cost: 5, sales: 0 });
    expect(v).toBeGreaterThan(1000);
    expect(Number.isFinite(v)).toBe(true);
  });
  test("unknown metric → null", () => expect(computeMetric("xyz", agg)).toBeNull());
});

describe("compare", () => {
  test("gt", () => { expect(compare(30, "gt", 25)).toBe(true); expect(compare(20, "gt", 25)).toBe(false); });
  test("gte", () => { expect(compare(25, "gte", 25)).toBe(true); });
  test("lt", () => { expect(compare(20, "lt", 25)).toBe(true); });
  test("lte", () => { expect(compare(25, "lte", 25)).toBe(true); });
});

describe("formatValue", () => {
  test("acos as %", () => expect(formatValue("acos", 25.3)).toBe("25.3%"));
  test("roas as ×", () => expect(formatValue("roas", 4)).toBe("4.00×"));
  test("spend as €", () => expect(formatValue("spend", 12.5)).toBe("€12.50"));
});

describe("evaluateWorkspaceAlerts", () => {
  const breachConfig = {
    id: "cfg-1", workspace_id: WS_ID, name: "High ACOS",
    conditions: { metric: "acos", operator: "gt", value: 20 },
    channels: { in_app: true, email: true, email_to: "boss@example.com" },
    suppression_hours: 24, last_triggered_at: null,
  };

  test("fires instance + email when threshold breached", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [breachConfig] })                       // load configs
      .mockResolvedValueOnce({ rows: [{ cost: 100, sales: 400, clicks: 50, impressions: 1000 }] }) // agg (acos=25 > 20)
      .mockResolvedValueOnce({ rows: [] })                                   // INSERT instance
      .mockResolvedValueOnce({ rows: [] });                                  // UPDATE last_triggered

    const r = await evaluateWorkspaceAlerts(WS_ID, { workspaceName: "WS" });

    expect(r).toEqual({ evaluated: 1, triggered: 1, emailed: 1 });
    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
    expect(sendAlertEmail).toHaveBeenCalledWith(expect.objectContaining({ to: ["boss@example.com"], alertName: "High ACOS" }));
    // instance insert happened
    expect(dbQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO alert_instances"), expect.any(Array));
  });

  test("does not fire when threshold not breached", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [breachConfig] })
      .mockResolvedValueOnce({ rows: [{ cost: 10, sales: 400, clicks: 50, impressions: 1000 }] }); // acos=2.5 < 20

    const r = await evaluateWorkspaceAlerts(WS_ID);
    expect(r.triggered).toBe(0);
    expect(sendAlertEmail).not.toHaveBeenCalled();
  });

  test("respects cooldown (recently triggered → skip)", async () => {
    const recent = { ...breachConfig, last_triggered_at: new Date().toISOString() };
    dbQuery
      .mockResolvedValueOnce({ rows: [recent] })
      .mockResolvedValueOnce({ rows: [{ cost: 100, sales: 400, clicks: 50, impressions: 1000 }] });

    const r = await evaluateWorkspaceAlerts(WS_ID);
    expect(r.triggered).toBe(0);
  });

  test("no active configs → no work", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const r = await evaluateWorkspaceAlerts(WS_ID);
    expect(r).toEqual({ evaluated: 0, triggered: 0, emailed: 0 });
  });

  test("BSR alert fires when product rank crosses threshold", async () => {
    const bsrConfig = {
      id: "cfg-bsr", workspace_id: WS_ID, name: "BSR drop",
      conditions: { metric: "bsr", operator: "gt", value: 5000, asin: "B0XXXXXXXX" },
      channels: { in_app: true }, suppression_hours: 24, last_triggered_at: null,
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [bsrConfig] })          // load configs
      .mockResolvedValueOnce({ rows: [{ best_rank: 8200 }] }) // latest BSR (8200 > 5000)
      .mockResolvedValueOnce({ rows: [] })                    // INSERT instance
      .mockResolvedValueOnce({ rows: [] });                   // UPDATE last_triggered

    const r = await evaluateWorkspaceAlerts(WS_ID);
    expect(r.triggered).toBe(1);
    expect(sendAlertEmail).not.toHaveBeenCalled(); // in-app only
  });

  test("BSR alert skipped when no snapshot exists", async () => {
    const bsrConfig = {
      id: "cfg-bsr2", workspace_id: WS_ID, name: "BSR drop",
      conditions: { metric: "bsr", operator: "gt", value: 5000, asin: "B0NONE00000" },
      channels: { in_app: true }, suppression_hours: 24, last_triggered_at: null,
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [bsrConfig] })
      .mockResolvedValueOnce({ rows: [] }); // no BSR snapshot

    const r = await evaluateWorkspaceAlerts(WS_ID);
    expect(r.triggered).toBe(0);
  });

  // ── Percentage-change operators (window vs prior window) ────────────────────
  const roasDropConfig = {
    id: "cfg-roas", workspace_id: WS_ID, name: "ROAS drop",
    conditions: { metric: "roas", operator: "drop_pct", value: 30, window_days: 7 },
    channels: { in_app: true, email: true, email_to: "boss@example.com" },
    suppression_hours: 24, last_triggered_at: null,
  };

  test("drop_pct fires when ROAS falls more than threshold % vs prior window", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [roasDropConfig] })                          // configs
      .mockResolvedValueOnce({ rows: [{ cost: 100, sales: 300, clicks: 50, impressions: 1000 }] }) // current: roas 3.0
      .mockResolvedValueOnce({ rows: [{ cost: 100, sales: 500, clicks: 50, impressions: 1000 }] }) // prior:   roas 5.0 → -40%
      .mockResolvedValueOnce({ rows: [] })                                        // INSERT instance
      .mockResolvedValueOnce({ rows: [] });                                       // UPDATE last_triggered

    const r = await evaluateWorkspaceAlerts(WS_ID, { workspaceName: "WS" });
    expect(r.triggered).toBe(1);
    expect(sendAlertEmail).toHaveBeenCalledWith(expect.objectContaining({
      metricLabel: "ROAS change", operatorLabel: "dropped ≥", threshold: "30%",
    }));
    // payload carries the % change and both window values
    const insertCall = dbQuery.mock.calls.find(c => String(c[0]).includes("INSERT INTO alert_instances"));
    const data = JSON.parse(insertCall[1][5]);
    expect(data).toMatchObject({ metric: "roas", operator: "drop_pct", change_pct: -40 });
    expect(data.prev).toBeCloseTo(5); expect(data.cur).toBeCloseTo(3);
  });

  test("drop_pct does NOT fire when the drop is below threshold", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [roasDropConfig] })
      .mockResolvedValueOnce({ rows: [{ cost: 100, sales: 450 }] }) // cur roas 4.5
      .mockResolvedValueOnce({ rows: [{ cost: 100, sales: 500 }] }); // prior roas 5.0 → -10%
    const r = await evaluateWorkspaceAlerts(WS_ID);
    expect(r.triggered).toBe(0);
  });

  test("drop_pct does NOT fire on a rise (ROAS improved)", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [roasDropConfig] })
      .mockResolvedValueOnce({ rows: [{ cost: 100, sales: 600 }] }) // cur roas 6.0
      .mockResolvedValueOnce({ rows: [{ cost: 100, sales: 400 }] }); // prior roas 4.0 → +50%
    const r = await evaluateWorkspaceAlerts(WS_ID);
    expect(r.triggered).toBe(0);
  });

  test("change operator skipped when prior window has no baseline (prev = 0)", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [roasDropConfig] })
      .mockResolvedValueOnce({ rows: [{ cost: 100, sales: 300 }] }) // cur roas 3.0
      .mockResolvedValueOnce({ rows: [{ cost: 0, sales: 0 }] });    // prior roas 0 → can't compute %
    const r = await evaluateWorkspaceAlerts(WS_ID);
    expect(r.triggered).toBe(0);
  });

  test("rise_pct fires when ACOS rises more than threshold %", async () => {
    const acosRise = {
      id: "cfg-acos", workspace_id: WS_ID, name: "ACOS spike",
      conditions: { metric: "acos", operator: "rise_pct", value: 25, window_days: 7 },
      channels: { in_app: true }, suppression_hours: 24, last_triggered_at: null,
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [acosRise] })
      .mockResolvedValueOnce({ rows: [{ cost: 100, sales: 250 }] }) // cur acos 40%
      .mockResolvedValueOnce({ rows: [{ cost: 100, sales: 500 }] }) // prior acos 20% → +100%
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const r = await evaluateWorkspaceAlerts(WS_ID);
    expect(r.triggered).toBe(1);
    expect(sendAlertEmail).not.toHaveBeenCalled(); // in-app only
  });

  test("spend alert attaches the top-campaigns breakdown to instance + email", async () => {
    const spendCfg = {
      id: "cfg-spend", workspace_id: WS_ID, name: "Перерасход",
      conditions: { metric: "spend", operator: "gt", value: 300, window_days: 1 },
      channels: { in_app: true, email: true, email_to: "boss@example.com" },
      suppression_hours: 24, last_triggered_at: null,
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [spendCfg] })                                  // load configs
      .mockResolvedValueOnce({ rows: [{ cost: 361.17, sales: 0, clicks: 0, impressions: 0 }] }) // agg (spend 361 > 300)
      .mockResolvedValueOnce({ rows: [                                              // topSpendCampaigns
        { name: "AM - SP - Magic", campaign_type: "sponsoredProducts", spend: "84.51", prev_spend: "50.99" },
      ] })
      .mockResolvedValueOnce({ rows: [] })                                          // INSERT instance
      .mockResolvedValueOnce({ rows: [] });                                         // UPDATE last_triggered

    const r = await evaluateWorkspaceAlerts(WS_ID, { workspaceName: "WS" });
    expect(r.triggered).toBe(1);
    const insertCall = dbQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO alert_instances"));
    const data = JSON.parse(insertCall[1][5]);
    expect(data.top_campaigns).toHaveLength(1);
    expect(data.top_campaigns[0]).toMatchObject({ name: "AM - SP - Magic", spend: 84.51, delta: 33.52 });
    expect(sendAlertEmail).toHaveBeenCalledWith(expect.objectContaining({
      topCampaigns: expect.arrayContaining([expect.objectContaining({ name: "AM - SP - Magic" })]),
    }));
  });
});

describe("topSpendCampaigns", () => {
  test("maps rows → spend/delta/delta_pct, handles zero prior (delta_pct null)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [
      { name: "AM - SP - Magic", campaign_type: "sponsoredProducts", spend: "84.51", prev_spend: "50.99" },
      { name: "New camp",        campaign_type: null,               spend: "10.00", prev_spend: "0" },
    ] });
    const out = await topSpendCampaigns(WS_ID, 1, 6);
    expect(out[0]).toEqual({ name: "AM - SP - Magic", campaign_type: "sponsoredProducts", spend: 84.51, prev_spend: 50.99, delta: 33.52, delta_pct: 66 });
    expect(out[1]).toEqual({ name: "New camp", campaign_type: null, spend: 10, prev_spend: 0, delta: 10, delta_pct: null });
  });
});

describe("detectMoverCauses", () => {
  // The fn runs 4 queries in order: wawi stock, fba inventory, order price, ad spend.
  const mockQueries = ({ wawi = [], fba = [], price = [], ad = [] }) => {
    dbQuery
      .mockResolvedValueOnce({ rows: wawi })
      .mockResolvedValueOnce({ rows: fba })
      .mockResolvedValueOnce({ rows: price })
      .mockResolvedValueOnce({ rows: ad });
  };

  it("only ERP known & 0 (FBA n/a) → erp_empty (medium), not a hard out-of-stock", async () => {
    mockQueries({ wawi: [{ asin: "B0AAA00001", stock: "0", nrows: "1" }] });
    const products = [{ asin: "B0AAA00001" }];
    await detectMoverCauses(WS_ID, products, 7);
    expect(products[0].causes).toEqual([
      { type: "erp_empty", severity: "medium", detail: "ERP: 0 · FBA: n/a" },
    ]);
  });

  it("both sources known & 0 → stock_out (high)", async () => {
    mockQueries({
      wawi: [{ asin: "B0AAA00010", stock: "0", nrows: "1" }],
      fba:  [{ asin: "B0AAA00010", sellable: "0", nn: "1" }],
    });
    const products = [{ asin: "B0AAA00010" }];
    await detectMoverCauses(WS_ID, products, 7);
    expect(products[0].causes).toEqual([
      { type: "stock_out", severity: "high", detail: "ERP: 0 · FBA: 0" },
    ]);
  });

  it("does NOT flag out-of-stock when ERP has units but FBA is 0 (sold via merchant)", async () => {
    // Regression: ERP 100 / FBA 0 must NOT be 'out of stock' (was a min() bug).
    mockQueries({
      wawi: [{ asin: "B0AAA00002", stock: "100", nrows: "1" }],
      fba: [{ asin: "B0AAA00002", sellable: "0", nn: "2" }],
    });
    const products = [{ asin: "B0AAA00002" }];
    await detectMoverCauses(WS_ID, products, 7, { lowStock: 10 });
    expect(products[0].causes).toEqual([]); // 100 units available → in stock
  });

  it("treats a mapped item with no stock row as UNKNOWN, not 0 (no false out-of-stock)", async () => {
    // Regression: wawi_stocks holds only positive rows; a mapped item with nrows=0 is
    // 'absent from feed', not a confirmed zero. With FBA also absent → no stock cause.
    mockQueries({ wawi: [{ asin: "B0AAA00003", stock: null, nrows: "0" }] });
    const products = [{ asin: "B0AAA00003" }];
    await detectMoverCauses(WS_ID, products, 7);
    expect(products[0].causes).toEqual([]);
  });

  it("genuine FBA 0 with ERP unknown → fba_empty (medium), not hard out-of-stock", async () => {
    mockQueries({
      wawi: [{ asin: "B0AAA00009", stock: null, nrows: "0" }], // ERP unknown
      fba:  [{ asin: "B0AAA00009", sellable: "0", nn: "2" }],  // FBA genuinely 0
    });
    const products = [{ asin: "B0AAA00009" }];
    await detectMoverCauses(WS_ID, products, 7);
    expect(products[0].causes).toEqual([
      { type: "fba_empty", severity: "medium", detail: "ERP: n/a · FBA: 0" },
    ]);
  });

  it("surfaces both stock sources and flags low stock by the larger (sellable-max) value", async () => {
    mockQueries({
      wawi: [{ asin: "B0AAA00004", stock: "4", nrows: "1" }],
      fba: [{ asin: "B0AAA00004", sellable: "2", nn: "1" }],
    });
    const products = [{ asin: "B0AAA00004" }];
    await detectMoverCauses(WS_ID, products, 7, { lowStock: 10 });
    expect(products[0].causes).toContainEqual(
      { type: "stock_low", severity: "medium", detail: "ERP: 4 · FBA: 2", value: 4 },
    );
  });

  // A breached "orders ↓" gives price_up / ad_cut a metric they can explain.
  const ORDERS_DOWN = [{ metric: "orders", direction: "down" }];

  it("honours config-driven thresholds (price rise below threshold → no cause)", async () => {
    // 10% price rise; default pricePct=5 flags it, pricePct=15 does not.
    const price = [{ asin: "B0AAA00003", price_cur: "11.00", price_prev: "10.00" }];
    mockQueries({ price });
    const a = [{ asin: "B0AAA00003", metrics: ORDERS_DOWN }];
    await detectMoverCauses(WS_ID, a, 7, { pricePct: 5 });
    expect(a[0].causes).toContainEqual(
      { type: "price_up", severity: "medium", pct: 10, detail: "€10.00 → €11.00" },
    );

    mockQueries({ price });
    const b = [{ asin: "B0AAA00003", metrics: ORDERS_DOWN }];
    await detectMoverCauses(WS_ID, b, 7, { pricePct: 15 });
    expect(b[0].causes).toEqual([]);
  });

  it("flags ad pullback when spend drops past the threshold (volume-metric breach)", async () => {
    mockQueries({ ad: [{ asin: "B0AAA00004", cost_cur: "0", cost_prev: "0.28" }] });
    const products = [{ asin: "B0AAA00004", metrics: ORDERS_DOWN }];
    await detectMoverCauses(WS_ID, products, 7, { adPct: 50 });
    expect(products[0].causes).toContainEqual(
      { type: "ad_cut", severity: "medium", pct: -100, detail: "€0.28 → €0.00" },
    );
  });

  it("does NOT show ad_cut/price_up for a pure ROAS drop (they'd contradict the move)", async () => {
    // Spend really fell and price really rose, but the product breached ONLY roas — a
    // spend cut RAISES roas, so 'ad cut' can't be the cause; suppress both demand causes.
    mockQueries({
      price: [{ asin: "B0AAA00006", price_cur: "12.00", price_prev: "10.00" }], // +20%
      ad:    [{ asin: "B0AAA00006", cost_cur: "8.39", cost_prev: "23.11" }],     // -64%
    });
    const products = [{ asin: "B0AAA00006", metrics: [{ metric: "roas", direction: "down" }] }];
    await detectMoverCauses(WS_ID, products, 7, { pricePct: 5, adPct: 50 });
    expect(products[0].causes).toEqual([]);
  });

  it("still shows ad_cut for an orders drop even if roas is also breached", async () => {
    mockQueries({ ad: [{ asin: "B0AAA00007", cost_cur: "8.39", cost_prev: "23.11" }] });
    const products = [{ asin: "B0AAA00007", metrics: [{ metric: "roas", direction: "down" }, { metric: "orders", direction: "down" }] }];
    await detectMoverCauses(WS_ID, products, 7, { adPct: 50 });
    expect(products[0].causes).toContainEqual(
      { type: "ad_cut", severity: "medium", pct: -64, detail: "€23.11 → €8.39" },
    );
  });

  it("does not invent a cause from a single missing source or a no-op move", async () => {
    // No wawi/fba rows → stock unknown; price flat → no price_up.
    mockQueries({ price: [{ asin: "B0AAA00005", price_cur: "10.00", price_prev: "10.00" }] });
    const products = [{ asin: "B0AAA00005", metrics: ORDERS_DOWN }];
    await detectMoverCauses(WS_ID, products, 7, { pricePct: 0 });
    expect(products[0].causes).toEqual([]);
  });
});
