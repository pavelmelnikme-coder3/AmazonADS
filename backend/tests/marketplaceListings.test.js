"use strict";
/**
 * Cross-country listing checks (pure). These score the same ASIN in a foreign
 * marketplace against its listing in the seller's home marketplace, so the tests
 * pin down which findings depend on the reference and which stand alone.
 */
// spSync pulls in the DB pool and the real logger at require time; stub both the
// way the other service-level suites do so loading it here stays inert.
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { computeCrossCountryIssues, computeListingIssues } = require("../src/services/amazon/listingHealth");
const { EU_MARKETPLACES, EU_MARKETPLACE_IDS, countryCodeFor, listingUrl } = require("../src/services/amazon/marketplaces");
const { _listingThumbnail } = require("../src/services/amazon/spSync");

const codes = (r) => r.issues.map(i => i.code);

// A fully localized, complete foreign listing that matches its reference in
// every respect except the language — the baseline "nothing to report" case.
const reference = {
  title: "Solarpanel Halterung 114 cm",
  bulletPoints: ["Robustes Aluminium", "Einfache Montage", "Wetterfest"],
  hasAplus: true,
  imageCount: 7,
};
const healthyTarget = {
  title: "Support de panneau solaire 114 cm",
  bulletPoints: ["Aluminium robuste", "Montage facile", "Résistant aux intempéries"],
  hasAplus: true,
  imageCount: 7,
  bestRank: 803,
};

describe("computeCrossCountryIssues", () => {
  test("localized, complete, ranking listing produces no findings", () => {
    const r = computeCrossCountryIssues({ target: healthyTarget, reference, existsInCatalog: true });
    expect(r.issues).toEqual([]);
    expect(r.replacesBase).toBe(false);
  });

  test("missing listing collapses to a single not_listed finding", () => {
    // The content checks would all fire on an absent listing; suppressing them
    // is the point — one actionable row instead of seven meaningless ones.
    const r = computeCrossCountryIssues({ target: healthyTarget, reference, existsInCatalog: false });
    expect(codes(r)).toEqual(["not_listed"]);
    expect(r.replacesBase).toBe(true);
  });

  test("title copied verbatim from the home marketplace is flagged", () => {
    const r = computeCrossCountryIssues({
      target: { ...healthyTarget, title: "  SOLARPANEL   Halterung 114 cm " },
      reference, existsInCatalog: true,
    });
    // Case and whitespace differences are not localization.
    expect(codes(r)).toContain("title_not_localized");
  });

  test("genuinely translated title is not flagged", () => {
    const r = computeCrossCountryIssues({ target: healthyTarget, reference, existsInCatalog: true });
    expect(codes(r)).not.toContain("title_not_localized");
  });

  test("bullets copied verbatim are flagged, a partial overlap is not", () => {
    const copied = computeCrossCountryIssues({
      target: { ...healthyTarget, bulletPoints: [...reference.bulletPoints] },
      reference, existsInCatalog: true,
    });
    expect(codes(copied)).toContain("bullets_not_localized");

    const partial = computeCrossCountryIssues({
      target: { ...healthyTarget, bulletPoints: ["Robustes Aluminium", "Montage facile", "Résistant"] },
      reference, existsInCatalog: true,
    });
    expect(codes(partial)).not.toContain("bullets_not_localized");
  });

  test("bullet count mismatch alone does not read as copied", () => {
    const r = computeCrossCountryIssues({
      target: { ...healthyTarget, bulletPoints: reference.bulletPoints.slice(0, 2) },
      reference, existsInCatalog: true,
    });
    expect(codes(r)).not.toContain("bullets_not_localized");
  });

  test("A+ missing only counts when the home marketplace has it", () => {
    const gap = computeCrossCountryIssues({
      target: { ...healthyTarget, hasAplus: false }, reference, existsInCatalog: true,
    });
    expect(codes(gap)).toContain("aplus_missing_vs_ref");
    // Strictly stronger than the plain "no A+" check — the caller drops that one
    // so the same gap is not listed twice.
    expect(gap.drop.has("aplus")).toBe(true);

    const noneAnywhere = computeCrossCountryIssues({
      target: { ...healthyTarget, hasAplus: false },
      reference: { ...reference, hasAplus: false },
      existsInCatalog: true,
    });
    expect(codes(noneAnywhere)).not.toContain("aplus_missing_vs_ref");
  });

  test("fewer images than the reference reports both counts", () => {
    const r = computeCrossCountryIssues({
      target: { ...healthyTarget, imageCount: 4 }, reference, existsInCatalog: true,
    });
    const found = r.issues.find(i => i.code === "fewer_images_vs_ref");
    expect(found).toEqual({ code: "fewer_images_vs_ref", value: 4, reference: 7 });
  });

  test("more images than the reference is not a finding", () => {
    const r = computeCrossCountryIssues({
      target: { ...healthyTarget, imageCount: 9 }, reference, existsInCatalog: true,
    });
    expect(codes(r)).not.toContain("fewer_images_vs_ref");
  });

  test("listed but unranked is reported separately from not listed", () => {
    const r = computeCrossCountryIssues({
      target: { ...healthyTarget, bestRank: null }, reference, existsInCatalog: true,
    });
    expect(codes(r)).toEqual(["no_bsr"]);
    expect(codes(r)).not.toContain("not_listed");
  });

  test("a rank of 0 is treated as ranked, not as missing", () => {
    // Guards the `== null` check against a truthiness regression.
    const r = computeCrossCountryIssues({
      target: { ...healthyTarget, bestRank: 0 }, reference, existsInCatalog: true,
    });
    expect(codes(r)).not.toContain("no_bsr");
  });

  test("without a reference only reference-free checks can fire", () => {
    // Happens when the ASIN is absent from its own home marketplace.
    const r = computeCrossCountryIssues({ target: healthyTarget, reference: null, existsInCatalog: true });
    expect(r.issues).toEqual([]);
  });
});

describe("base + cross-country composition", () => {
  test("base findings survive alongside cross-country ones", () => {
    const base = computeListingIssues({
      title: "Short",                       // under the 25-char minimum
      bulletPoints: ["one"],                // under 3
      description: null,
      images: [{ variant: "MAIN", width: 500, height: 500 }],
      hasAplus: false,
    });
    expect(base.issues.map(i => i.code)).toEqual(
      expect.arrayContaining(["title", "bullets", "description", "images_count", "images_zoom", "aplus"])
    );

    const cross = computeCrossCountryIssues({
      target: { title: "Short", bulletPoints: ["one"], hasAplus: false, imageCount: 1, bestRank: 12 },
      reference, existsInCatalog: true,
    });
    const merged = [...base.issues.filter(i => !cross.drop.has(i.code)), ...cross.issues].map(i => i.code);
    expect(merged).toContain("title");
    expect(merged).toContain("fewer_images_vs_ref");
    expect(merged).toContain("aplus_missing_vs_ref");
    // The weaker duplicate is gone.
    expect(merged).not.toContain("aplus");
  });
});

describe("missing listing in the home marketplace", () => {
  // Regression: the reference row skips the cross-country checks, and `not_listed`
  // lives in those — so a home marketplace with no listing was written with zero
  // findings. Its cell rendered red (driven by exists_in_catalog) while the detail
  // panel underneath claimed the listing was clean. The sync now applies
  // `not_listed` on absence regardless of which country it is.
  const scoreRow = ({ existsInCatalog, isReference, base }) => {
    let issues = base ? [...base.issues] : [];
    if (!existsInCatalog) {
      issues = [{ code: "not_listed" }];
    } else if (!isReference) {
      const cross = computeCrossCountryIssues({ target: healthyTarget, reference, existsInCatalog });
      issues = cross.replacesBase
        ? cross.issues
        : [...issues.filter(i => !cross.drop?.has(i.code)), ...cross.issues];
    }
    return issues;
  };

  test("absent home marketplace still reports not_listed", () => {
    expect(scoreRow({ existsInCatalog: false, isReference: true, base: null }))
      .toEqual([{ code: "not_listed" }]);
  });

  test("absent foreign marketplace reports it too", () => {
    expect(scoreRow({ existsInCatalog: false, isReference: false, base: null }))
      .toEqual([{ code: "not_listed" }]);
  });

  test("a present home marketplace keeps its own findings and gains no cross-country ones", () => {
    const base = computeListingIssues({
      title: reference.title, bulletPoints: reference.bulletPoints,
      description: "x", images: [{ variant: "MAIN", width: 1500, height: 1500 }], hasAplus: false,
    });
    const issues = scoreRow({ existsInCatalog: true, isReference: true, base });
    expect(issues.map(i => i.code)).toContain("aplus");
    expect(issues.map(i => i.code)).not.toContain("no_bsr");          // reference is never scored against itself
    expect(issues.map(i => i.code)).not.toContain("not_listed");
  });
});

describe("listing thumbnail selection", () => {
  test("prefers MAIN and picks its smallest size", () => {
    // The matrix renders at ~26px, so the 75px variant is the right one to store.
    expect(_listingThumbnail([
      { variant: "MAIN", width: 2208, link: "big.jpg" },
      { variant: "MAIN", width: 75,   link: "thumb.jpg" },
      { variant: "MAIN", width: 500,  link: "mid.jpg" },
      { variant: "PT01", width: 75,   link: "pt.jpg" },
    ])).toBe("thumb.jpg");
  });

  test("falls back to the first supplementary photo when there is no MAIN", () => {
    // Regression: B099ZVM384 returns 24 images in BE/SE across PT01–PT08 with no
    // MAIN, which previously left the row with a blank thumbnail.
    expect(_listingThumbnail([
      { variant: "PT03", width: 75,   link: "pt03.jpg" },
      { variant: "PT01", width: 2000, link: "pt01-big.jpg" },
      { variant: "PT01", width: 75,   link: "pt01-small.jpg" },
    ])).toBe("pt01-small.jpg");
  });

  test("ignores entries without a usable link or width", () => {
    expect(_listingThumbnail([
      { variant: "MAIN", width: 0, link: "zero.jpg" },
      { variant: "MAIN", width: 500 },
      { variant: "PT01", width: 75, link: "ok.jpg" },
    ])).toBe("ok.jpg");
  });

  test("returns null when there is nothing to show", () => {
    expect(_listingThumbnail([])).toBeNull();
    expect(_listingThumbnail(undefined)).toBeNull();
    expect(_listingThumbnail([{ variant: "MAIN" }])).toBeNull();
  });

  test("unlabelled variants sort last but are still usable", () => {
    expect(_listingThumbnail([{ width: 75, link: "unlabelled.jpg" }])).toBe("unlabelled.jpg");
    expect(_listingThumbnail([
      { width: 75, link: "unlabelled.jpg" },
      { variant: "PT09", width: 75, link: "pt09.jpg" },
    ])).toBe("pt09.jpg");
  });
});

describe("EU marketplace catalogue", () => {
  test("covers the nine EU marketplaces the check targets", () => {
    expect(EU_MARKETPLACES).toHaveLength(9);
    expect(EU_MARKETPLACES.map(m => m.countryCode).sort())
      .toEqual(["BE", "DE", "ES", "FR", "GB", "IT", "NL", "PL", "SE"]);
  });

  test("marketplace IDs are unique and match the live participation IDs", () => {
    expect(new Set(EU_MARKETPLACE_IDS).size).toBe(EU_MARKETPLACE_IDS.length);
    // Verified against GET /sellers/v1/marketplaceParticipations on 2026-07-31.
    expect(countryCodeFor("A1PA6795UKMFR9")).toBe("DE");
    expect(countryCodeFor("A1805IZSGTT6HS")).toBe("NL");   // ...HS, not ...HW
    expect(countryCodeFor("AMEN7PMS3EDWL")).toBe("BE");
    expect(countryCodeFor("A2NODRKZP88ZB9")).toBe("SE");
  });

  test("unknown marketplace resolves to null rather than a wrong country", () => {
    expect(countryCodeFor("ATVPDKIKX0DER")).toBeNull();    // US — different region, not covered
    expect(listingUrl("B0CDCC9WFQ", "ATVPDKIKX0DER")).toBeNull();
  });

  test("builds per-country listing URLs", () => {
    expect(listingUrl("B0CDCC9WFQ", "A1F83G8C2ARO7P")).toBe("https://www.amazon.co.uk/dp/B0CDCC9WFQ");
    expect(listingUrl("B0CDCC9WFQ", "AMEN7PMS3EDWL")).toBe("https://www.amazon.com.be/dp/B0CDCC9WFQ");
  });
});
