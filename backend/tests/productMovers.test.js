"use strict";
/**
 * Product-movers dedup tests — per-ASIN cooldown + escalation (C) and the helpers
 * behind the New/Worsening split (D). Pure logic + getRecentMoverHistory parsing.
 */
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../src/services/email", () => ({ sendProductMoversEmail: jest.fn().mockResolvedValue(undefined), sendAlertEmail: jest.fn() }));

const { query: dbQuery } = require("../src/db/pool");
const { moverWorstPct, partitionMovers, getRecentMoverHistory } = require("../src/services/alerts/evaluate");

const DAY = 86400000;
const prod = (asin, pct) => ({ asin, title: asin, metrics: Array.isArray(pct) ? pct.map((x) => ({ pct: x })) : [{ pct }] });

beforeEach(() => jest.clearAllMocks());

describe("moverWorstPct", () => {
  test("largest magnitude across metrics (signed)", () => {
    expect(moverWorstPct([{ pct: -40 }, { pct: 12 }])).toBe(40);
    expect(moverWorstPct([{ pct: 30 }, { pct: -75 }])).toBe(75);
  });
  test("empty / missing → 0", () => {
    expect(moverWorstPct([])).toBe(0);
    expect(moverWorstPct(undefined)).toBe(0);
  });
});

describe("partitionMovers", () => {
  const now = 1_000 * DAY; // fixed clock

  test("cooldown off (0) → everything is fresh, nothing suppressed", () => {
    const hist = new Map([["A1", { lastAt: now - DAY, worstPct: 50 }]]);
    const r = partitionMovers([prod("A1", -60), prod("A2", -30)], hist, { cooldownDays: 0, escalationPct: 25, now });
    expect(r.fresh.map((p) => p.asin)).toEqual(["A1", "A2"]);
    expect(r.escalated).toHaveLength(0);
    expect(r.suppressed).toHaveLength(0);
    expect(r.fresh[0].status).toBe("new");
  });

  test("no history → fresh", () => {
    const r = partitionMovers([prod("NEW", -40)], new Map(), { cooldownDays: 7, escalationPct: 25, now });
    expect(r.fresh.map((p) => p.asin)).toEqual(["NEW"]);
    expect(r.suppressed).toHaveLength(0);
  });

  test("within cooldown, not materially worse → suppressed", () => {
    const hist = new Map([["A1", { lastAt: now - 2 * DAY, worstPct: 40 }]]);
    const r = partitionMovers([prod("A1", -50)], hist, { cooldownDays: 7, escalationPct: 25, now }); // 50 < 40+25
    expect(r.suppressed.map((p) => p.asin)).toEqual(["A1"]);
    expect(r.fresh).toHaveLength(0);
    expect(r.escalated).toHaveLength(0);
  });

  test("within cooldown, worsened by ≥ escalation_pct → escalated (with prev_worst_pct)", () => {
    const hist = new Map([["A1", { lastAt: now - 2 * DAY, worstPct: 40 }]]);
    const r = partitionMovers([prod("A1", -65)], hist, { cooldownDays: 7, escalationPct: 25, now }); // 65 >= 40+25
    expect(r.escalated).toHaveLength(1);
    expect(r.escalated[0].asin).toBe("A1");
    expect(r.escalated[0].status).toBe("escalated");
    expect(r.escalated[0].prev_worst_pct).toBe(40);
    expect(r.suppressed).toHaveLength(0);
  });

  test("escalation boundary is inclusive (exactly +escalation → escalated)", () => {
    const hist = new Map([["A1", { lastAt: now - DAY, worstPct: 40 }]]);
    expect(partitionMovers([prod("A1", -65)], hist, { cooldownDays: 7, escalationPct: 25, now }).escalated).toHaveLength(1);
    expect(partitionMovers([prod("A1", -64)], hist, { cooldownDays: 7, escalationPct: 25, now }).suppressed).toHaveLength(1);
  });

  test("escalation_pct = 0 → never re-surface within cooldown (pure suppress)", () => {
    const hist = new Map([["A1", { lastAt: now - DAY, worstPct: 40 }]]);
    const r = partitionMovers([prod("A1", -200)], hist, { cooldownDays: 7, escalationPct: 0, now });
    expect(r.suppressed).toHaveLength(1);
    expect(r.escalated).toHaveLength(0);
  });

  test("history older than cooldown → fresh again (auto-reset)", () => {
    const hist = new Map([["A1", { lastAt: now - 8 * DAY, worstPct: 90 }]]);
    const r = partitionMovers([prod("A1", -30)], hist, { cooldownDays: 7, escalationPct: 25, now });
    expect(r.fresh.map((p) => p.asin)).toEqual(["A1"]);
    expect(r.suppressed).toHaveLength(0);
  });

  test("case-insensitive ASIN match against history", () => {
    const hist = new Map([["A1", { lastAt: now - DAY, worstPct: 40 }]]);
    const r = partitionMovers([prod("a1", -45)], hist, { cooldownDays: 7, escalationPct: 25, now });
    expect(r.suppressed.map((p) => p.asin)).toEqual(["a1"]); // original casing preserved, matched lower→upper
  });

  test("mixed batch → correct partition", () => {
    const hist = new Map([
      ["OLD", { lastAt: now - 2 * DAY, worstPct: 30 }],   // within, not worse → suppressed
      ["WORSE", { lastAt: now - 2 * DAY, worstPct: 30 }], // within, worse → escalated
      ["STALE", { lastAt: now - 30 * DAY, worstPct: 99 }], // expired → fresh
    ]);
    const r = partitionMovers(
      [prod("OLD", -35), prod("WORSE", -80), prod("STALE", -40), prod("BRAND_NEW", -50)],
      hist, { cooldownDays: 7, escalationPct: 25, now }
    );
    expect(r.fresh.map((p) => p.asin).sort()).toEqual(["BRAND_NEW", "STALE"]);
    expect(r.escalated.map((p) => p.asin)).toEqual(["WORSE"]);
    expect(r.suppressed.map((p) => p.asin)).toEqual(["OLD"]);
  });
});

describe("getRecentMoverHistory", () => {
  test("returns empty map without querying when configId/sinceDays missing", async () => {
    expect((await getRecentMoverHistory(null, 7)).size).toBe(0);
    expect((await getRecentMoverHistory("cfg", 0)).size).toBe(0);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  test("takes the MOST RECENT alert per ASIN and computes worstPct", async () => {
    const t2 = "2026-06-04T13:00:00Z"; // newest first
    const t1 = "2026-06-03T13:00:00Z";
    dbQuery.mockResolvedValueOnce({
      rows: [
        { created_at: t2, data: { products: [{ asin: "A1", metrics: [{ pct: -65 }, { pct: 10 }] }, { asin: "A2", metrics: [{ pct: -20 }] }] } },
        { created_at: t1, data: { products: [{ asin: "A1", metrics: [{ pct: -40 }] }, { asin: "A3", metrics: [{ pct: -55 }] }] } },
      ],
    });
    const map = await getRecentMoverHistory("cfg-1", 7);
    expect(map.get("A1")).toEqual({ lastAt: new Date(t2).getTime(), worstPct: 65 }); // newest wins (65, not 40)
    expect(map.get("A2").worstPct).toBe(20);
    expect(map.get("A3").worstPct).toBe(55); // only in older row → still captured
    expect(map.size).toBe(3);
  });

  test("tolerates data stored as a JSON string", async () => {
    dbQuery.mockResolvedValueOnce({
      rows: [{ created_at: "2026-06-04T13:00:00Z", data: JSON.stringify({ products: [{ asin: "B1", metrics: [{ pct: -80 }] }] }) }],
    });
    const map = await getRecentMoverHistory("cfg-1", 7);
    expect(map.get("B1").worstPct).toBe(80);
  });
});
