"use strict";
/**
 * Lead Finder query building — the free-text query must become the tags OSM actually uses.
 *
 * The old builder split the query on spaces and ORed the words across
 * name/amenity/shop/cuisine/craft/office. Two consequences, and together they turned one
 * search into a different one without saying so:
 *
 *   1. OR means the broadest word decides. "asiatisches restaurant" became
 *      `asiatisches|restaurant`, and `amenity=restaurant` is on every restaurant, so the
 *      qualifier did nothing. The live 2026-07-15 Germany run returned 500 businesses of
 *      which 39 (7.8%) were actually Asian, 208 were plain `restaurant` with no cuisine, and
 *      119 were literally the same rows as a plain "restaurant" search hours earlier.
 *   2. Even ANDed it could not have matched: OSM writes `cuisine=chinese`, never
 *      "asiatisches", so a German adjective matches no value anywhere.
 */
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { buildFilters, buildQuery, interpretQuery } = require("../src/services/leadFinder/overpass");
const { spreadTileOrder, perTileCap, buildTileGrid, MIN_RESULTS_PER_TILE } =
  require("../src/services/leadFinder/tiles");

describe("cuisine queries become cuisine tags, not a bare amenity match", () => {
  test("'asiatisches restaurant' filters on cuisine — it does NOT match every restaurant", () => {
    const f = buildFilters("asiatisches restaurant");
    expect(f).toMatch(/\[amenity~"\^\(restaurant\|fast_food\)\$"\]/);
    expect(f).toMatch(/\[~"\^\(cuisine\|name\)\$"~"[^"]*chinese[^"]*",i\]/);
    // The regression: a filter that accepts the bare word "restaurant" across every key is
    // what let Bavarian inns into an Asian-restaurant list.
    expect(f).not.toMatch(/\^\(name\|amenity\|shop\|cuisine\|craft\|office\)\$"~"restaurant"/);
  });

  test("the German adjective is translated to English OSM values, not matched literally", () => {
    const { cuisineValues } = interpretQuery("asiatisches restaurant");
    expect(cuisineValues).toEqual(expect.arrayContaining(
      ["asian", "chinese", "vietnamese", "thai", "japanese", "korean", "sushi"]));
  });

  test("German inflections all reduce to the same stem", () => {
    for (const q of ["asiatisch", "asiatisches", "asiatische", "asiatischer"]) {
      expect(interpretQuery(q).cuisineValues).toContain("chinese");
    }
  });

  test("the user's own word is kept in the name pattern — many places carry no cuisine tag", () => {
    expect(buildFilters("asiatisches restaurant")).toMatch(/asiatisches/);
  });

  test("a narrower cuisine stays narrow", () => {
    const { cuisineValues } = interpretQuery("chinesisches restaurant");
    expect(cuisineValues).toEqual(expect.arrayContaining(["chinese"]));
    expect(cuisineValues).not.toContain("thai");
  });

  test("a named venue widens rather than restricts — 'sushi bar' is idiom, not amenity=bar", () => {
    const f = buildFilters("sushi bar");
    expect(f).toMatch(/amenity~"\^\([^"]*restaurant[^"]*\)\$"/);
    expect(f).toMatch(/amenity~"\^\([^"]*bar[^"]*\)\$"/);
  });

  test("no duplicate alternatives in the cuisine pattern", () => {
    const m = buildFilters("pizza").match(/~"\^\(cuisine\|name\)\$"~"([^"]+)",i/);
    const alts = m[1].split("|");
    expect(new Set(alts).size).toBe(alts.length);
  });
});

describe("multi-word queries are ANDed", () => {
  test("every free word becomes its own filter (conjunction), not an alternation", () => {
    const f = buildFilters("autowerkstatt hannover");
    expect(f).toMatch(/~"autowerkstatt",i\]\[~/);        // two chained filters
    expect(f).toMatch(/~"hannover",i\]/);
    expect(f).not.toMatch(/autowerkstatt\|hannover/);    // the old OR
  });

  test("a bare venue word is just the amenity filter, with no broad word match beside it", () => {
    expect(buildFilters("restaurant")).toBe('[amenity~"^(restaurant)$"]');
  });

  test("a venue word plus a place name keeps the place name as an AND filter", () => {
    const f = buildFilters("restaurant hannover");
    expect(f).toMatch(/^\[amenity~"\^\(restaurant\)\$"\]/);
    expect(f).toMatch(/~"hannover",i\]/);
  });

  test("an empty query is still rejected", () => {
    expect(() => buildFilters("   ")).toThrow(/query required/);
  });

  test("the assembled query keeps the bbox, both element types and the limit", () => {
    const q = buildQuery({ south: 1, west: 2, north: 3, east: 4 }, "asiatisches restaurant", 42);
    expect(q).toContain("node[amenity");
    expect(q).toContain("way[amenity");
    expect(q).toContain("(1,2,3,4)");
    expect(q).toContain("out center tags 42;");
  });
});

describe("tile coverage is spread, so a spent budget still samples the whole region", () => {
  // Germany's grid at 0.5°: 16 rows x 19 cols, walked south -> north by buildTileGrid.
  const germany = buildTileGrid({ south: 47.27, north: 55.06, west: 5.87, east: 15.04 });

  test("reordering visits every tile exactly once", () => {
    const ordered = spreadTileOrder(germany);
    expect(ordered).toHaveLength(germany.length);
    expect(new Set(ordered.map(t => `${t.south},${t.west}`)).size).toBe(germany.length);
  });

  test("the first tiles visited span the region, not one edge of it", () => {
    // The live failure: 24 tiles were visited and every result landed in 47.34-48.20N.
    const firstLats = spreadTileOrder(germany).slice(0, 24).map(t => t.south);
    expect(Math.max(...firstLats) - Math.min(...firstLats)).toBeGreaterThan(5);

    const naiveLats = germany.slice(0, 24).map(t => t.south);
    expect(Math.max(...naiveLats) - Math.min(...naiveLats)).toBeLessThan(1);
  });

  test("the order is deterministic — the same search reorders the same way", () => {
    expect(spreadTileOrder(germany)).toEqual(spreadTileOrder(germany));
  });

  test("a trivially small grid is left alone", () => {
    const tiny = germany.slice(0, 3);
    expect(spreadTileOrder(tiny)).toEqual(tiny);
  });

  test("each tile gets a share of the budget, never the whole of it", () => {
    expect(perTileCap(304, 500)).toBe(2 > MIN_RESULTS_PER_TILE ? 2 : MIN_RESULTS_PER_TILE);
    expect(perTileCap(304, 500)).toBeLessThan(500);
  });

  test("sparse grids still get a usable floor per tile", () => {
    expect(perTileCap(1000, 500)).toBe(MIN_RESULTS_PER_TILE);
  });

  test("an untiled search keeps the whole budget", () => {
    expect(perTileCap(1, 500)).toBe(500);
  });
});
