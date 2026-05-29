"use strict";
/**
 * Alert evaluation engine tests — pure metric helpers + evaluateWorkspaceAlerts.
 */
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../src/services/email", () => ({ sendAlertEmail: jest.fn().mockResolvedValue(undefined) }));

const { query: dbQuery } = require("../src/db/pool");
const { sendAlertEmail } = require("../src/services/email");
const { computeMetric, compare, formatValue, evaluateWorkspaceAlerts } = require("../src/services/alerts/evaluate");

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
});
