/**
 * The display helpers. Each case here is one where the interface previously stated something
 * untrue: a blocked rank check shown as "unranked", a rule's evidence shown as "[object Object]",
 * a product with no Amazon title shown as a bare ASIN.
 */
import { describe, test, expect } from "vitest";
import { positionBadge, auditValueText, auditValueTitle, productDisplayName } from "./display.js";

describe("positionBadge", () => {
  // The whole point of the change: blocked and unranked must not look alike.
  test("a blocked check is marked as unknown, not as unranked", () => {
    const blocked = positionBadge(null, false, true);
    const unranked = positionBadge(null, false, false);
    expect(blocked.label).toBe("?");
    expect(blocked.blocked).toBe(true);
    expect(unranked.label).toBe("—");
    expect(unranked.blocked).toBeUndefined();
    expect(blocked.color).not.toBe(unranked.color);
  });

  // Amazon refusing the lookup says nothing about where the product ranks, so a stale position
  // must not be painted as current.
  test("blocked wins even when a position is passed alongside it", () => {
    expect(positionBadge(3, true, true).label).toBe("?");
  });

  test.each([
    [null, false], [0, true], [undefined, false],
  ])("no position (%s) renders the dash", (pos, found) => {
    expect(positionBadge(pos, found, false).label).toBe("—");
  });

  test("found but position 0 is still a dash, not #0", () => {
    expect(positionBadge(0, true, false).label).toBe("—");
  });

  test.each([[1], [3], [4], [10], [11], [20], [21], [48], [49], [100]])(
    "rank %i renders as #n", (pos) => {
      expect(positionBadge(pos, true, false).label).toBe(`#${pos}`);
    }
  );

  // Each tier must be visually distinct, and the boundaries are the part that is easy to get wrong.
  test("the tier boundaries change colour where they should", () => {
    const c = (p) => positionBadge(p, true, false).color;
    expect(c(3)).not.toBe(c(4));
    expect(c(10)).not.toBe(c(11));
    expect(c(20)).not.toBe(c(21));
    expect(c(48)).not.toBe(c(49));
    expect(c(1)).toBe(c(3));
    expect(c(4)).toBe(c(10));
  });

  test("every badge carries a full set of styles", () => {
    for (const b of [positionBadge(null, false, true), positionBadge(null, false, false), positionBadge(7, true, false)]) {
      expect(b).toMatchObject({ label: expect.any(String), bg: expect.any(String), color: expect.any(String), border: expect.any(String) });
    }
  });
});

describe("auditValueText", () => {
  test("scalars read as themselves", () => {
    expect(auditValueText("PAUSED")).toBe("PAUSED");
    expect(auditValueText(42)).toBe("42");
    expect(auditValueText(0)).toBe("0");
    expect(auditValueText(false)).toBe("false");
  });

  test("missing values read as a dash", () => {
    expect(auditValueText(null)).toBe("—");
    expect(auditValueText(undefined)).toBe("—");
  });

  // This is the "[object Object]" case: the metrics a rule matched on are the evidence for why it
  // fired, and they were unreadable.
  test("an object becomes key=value pairs", () => {
    expect(auditValueText({ acos: 0.45, clicks: 12 })).toBe("acos=0.45 clicks=12");
  });

  test("long decimals are rounded to two places", () => {
    expect(auditValueText({ acos: 0.456789 })).toBe("acos=0.46");
    expect(auditValueText({ roas: 2.0 })).toBe("roas=2");
  });

  test("arrays are joined", () => {
    expect(auditValueText(["a", "b"])).toBe("a, b");
    expect(auditValueText([])).toBe("—");
  });

  test("nesting does not produce [object Object] at any depth", () => {
    const text = auditValueText({ scope: { campaign: "x", metrics: { acos: 1.5 } } });
    expect(text).not.toContain("[object Object]");
    expect(text).toContain("acos=1.5");
  });

  test("an empty object reads as a dash", () => {
    expect(auditValueText({})).toBe("—");
  });
});

describe("auditValueTitle", () => {
  test("objects get the full JSON for the hover", () => {
    expect(auditValueTitle({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 1));
  });

  // A scalar is already shown in full, so a tooltip repeating it is noise.
  test("scalars and blanks get no title", () => {
    expect(auditValueTitle("PAUSED")).toBeUndefined();
    expect(auditValueTitle(7)).toBeUndefined();
    expect(auditValueTitle(null)).toBeUndefined();
  });
});

describe("productDisplayName", () => {
  test("the Amazon title wins when there is one", () => {
    expect(productDisplayName({ title: "Keilkissen", wawi_name: "Lagerartikel_Keil" }))
      .toEqual({ name: "Keilkissen", fromWawi: false });
  });

  // Half this catalogue is dead in the home marketplace, so there is no listing title to scrape.
  test("the ERP name stands in, flagged as the ERP's wording", () => {
    expect(productDisplayName({ title: null, wawi_name: "Keilkissen 60x50" }))
      .toEqual({ name: "Keilkissen 60x50", fromWawi: true });
  });

  test("whitespace-only names count as absent", () => {
    expect(productDisplayName({ title: "   ", wawi_name: "Keil" })).toEqual({ name: "Keil", fromWawi: true });
    expect(productDisplayName({ title: "   ", wawi_name: "  " })).toEqual({ name: "", fromWawi: false });
  });

  test("names are trimmed", () => {
    expect(productDisplayName({ title: "  Keilkissen  " }).name).toBe("Keilkissen");
  });

  test("with nothing to show the caller gets an empty name to fall back on the ASIN", () => {
    expect(productDisplayName({})).toEqual({ name: "", fromWawi: false });
    expect(productDisplayName(null)).toEqual({ name: "", fromWawi: false });
    expect(productDisplayName(undefined)).toEqual({ name: "", fromWawi: false });
  });
});
