"use strict";
/** JTL-Wawi item → row mapping (pure). Verifies cost, identifiers and the ASIN bridge. */
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../src/config/encryption", () => ({ encrypt: (s) => s, decrypt: (s) => s }));

const { mapItem } = require("../src/services/wawi/sync");
const WS = "ws-1";

// Mirrors the shape returned by the live GET /items endpoint.
const liveItem = {
  Id: 1, SKU: "1", ManufacturerId: 356, IsActive: true, ParentItemId: 0,
  Name: "Polypropylen / 030 Yonix", TaxClassId: 1,
  Identifiers: { Gtin: "4260451861193", ManufacturerNumber: "2012", AmazonFnsku: "X00ABC", Asins: ["B0C7GS2RRD", "b0c7gshlpw"] },
  ItemPriceData: { SalesPriceNet: 9.9747899159664, SuggestedRetailPrice: 0, PurchasePriceNet: 7.3925, AmazonPrice: 0 },
  Categories: [{ CategoryId: 1, Name: "Archiv" }], ActiveSalesChannels: ["9-7-2--1"],
  Added: "2018-09-02T00:00:00+02:00", Changed: "2023-06-13T15:59:44+02:00",
};

describe("mapItem", () => {
  const r = mapItem(WS, liveItem);

  test("core identity + cost", () => {
    expect(r.workspace_id).toBe(WS);
    expect(r.wawi_id).toBe(1);
    expect(r.sku).toBe("1");
    expect(r.gtin).toBe("4260451861193");
    expect(r.amazon_fnsku).toBe("X00ABC");
    expect(r.purchase_price_net).toBeCloseTo(7.3925);   // COST — the key Amazon never gives
    expect(r.sales_price_net).toBeCloseTo(9.97479);
  });

  test("ASINs captured as JSON array (raw casing preserved)", () => {
    expect(JSON.parse(r.asins)).toEqual(["B0C7GS2RRD", "b0c7gshlpw"]);
  });

  test("timestamps passed through; sentinel 0001-01-01 nulled", () => {
    expect(r.changed_at).toBe("2023-06-13T15:59:44+02:00");
    expect(mapItem(WS, { Id: 2, Added: "0001-01-01T00:00:00+00:00" }).added_at).toBeNull();
  });

  test("missing price/identifiers degrade to null, not NaN", () => {
    const r2 = mapItem(WS, { Id: 3, Name: "x" });
    expect(r2.purchase_price_net).toBeNull();
    expect(r2.gtin).toBeNull();
    expect(JSON.parse(r2.asins)).toEqual([]);
  });
});
