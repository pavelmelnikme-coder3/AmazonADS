"use strict";
/**
 * Emails OSM already publishes.
 *
 * The lead pipeline was built around one source of addresses: fetch the business's website
 * and read an address out of the HTML. But OSM carries `email` / `contact:email` on a good
 * share of businesses, and the mapper dropped both — so the scraper re-fetched someone
 * else's site to learn what the search result had already handed us, and any lead with an
 * address but no website was written off as 'no_website' and never revisited.
 *
 * Taking the tag is strictly better: no request to a third party, and it reaches leads the
 * scraper structurally cannot. It is also the more trustworthy of the two — a published
 * contact address, not whatever `mailto:` a page happens to carry.
 */
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../src/db/pool", () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));

const { pickEmails } = require("../src/services/leadFinder/overpass");
const { persistResults } = require("../src/services/leadFinder/persistResults");
const { query } = require("../src/db/pool");

describe("pickEmails", () => {
  test("reads both the plain and the namespaced tag", () => {
    expect(pickEmails({ email: "info@wok.de" })).toEqual(["info@wok.de"]);
    expect(pickEmails({ "contact:email": "hallo@sushi.de" })).toEqual(["hallo@sushi.de"]);
  });

  test("splits the multi-value form OSM allows", () => {
    expect(pickEmails({ email: "a@x.de;b@y.de" })).toEqual(["a@x.de", "b@y.de"]);
  });

  test("keeps one copy when both tags say the same thing, case aside", () => {
    expect(pickEmails({ email: "Info@Wok.de", "contact:email": "info@wok.de" })).toEqual(["info@wok.de"]);
  });

  test("drops anything that is not plainly an address", () => {
    // A mailing list is not the place to find out that "siehe website" was not an address.
    expect(pickEmails({ email: "siehe website" })).toEqual([]);
    expect(pickEmails({ email: "info@localhost" })).toEqual([]);
    expect(pickEmails({ email: "@wok.de" })).toEqual([]);
  });

  test("a business with no address tag yields none, not a null", () => {
    expect(pickEmails({ name: "Asia Wok" })).toEqual([]);
  });
});

describe("persistResults", () => {
  const business = (over = {}) => ({
    osm_type: "node", osm_id: 1, name: "Asia Wok", category: "restaurant (chinese)",
    address: "Hauptstr. 1, 80331, München", lat: 48.1, lon: 11.5,
    website: "https://asia-wok.de", phone: null, emails: [], ...over,
  });

  beforeEach(() => jest.clearAllMocks());

  test("a lead that came with an address is already found, so the scraper skips it", async () => {
    await persistResults("s1", "ws1", [business({ emails: ["info@wok.de"] })]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/scrape_status/);
    expect(sql).toMatch(/THEN 'found' ELSE 'pending' END/);
    expect(params[11]).toEqual(['{"info@wok.de"}']);
  });

  test("a lead with no address stays pending and takes the website route", async () => {
    await persistResults("s1", "ws1", [business()]);
    const [, params] = query.mock.calls[0];
    expect(params[11]).toEqual(["{}"]);
  });

  test("per-row lists travel as literals — Postgres has no ragged array-of-arrays", async () => {
    await persistResults("s1", "ws1", [
      business({ osm_id: 1, emails: ["a@x.de", "b@y.de"] }),
      business({ osm_id: 2, emails: [] }),
      business({ osm_id: 3, emails: ["c@z.de"] }),
    ]);
    const [sql, params] = query.mock.calls[0];
    expect(params[11]).toEqual(['{"a@x.de","b@y.de"}', "{}", '{"c@z.de"}']);
    expect(sql).toMatch(/\$12::text\[\]/);
    expect(sql).toMatch(/u\.emails::text\[\]/);
  });

  test("seeing a lead again never overwrites addresses already held for it", async () => {
    // The stored ones may have come from a scrape that read more of the site than the tags say.
    await persistResults("s1", "ws1", [business({ emails: ["info@wok.de"] })]);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/emails = CASE WHEN COALESCE\(array_length\(lead_results\.emails, 1\), 0\) > 0/);
    expect(sql).toMatch(/THEN lead_results\.emails ELSE EXCLUDED\.emails END/);
  });

  test("supplying the first address for a known lead makes it found, whatever it was called before", async () => {
    // Including a row an earlier scrape wrote off as 'no_email' or 'no_website': the status
    // describes whether an address is held, and now one is.
    await persistResults("s1", "ws1", [business({ emails: ["info@wok.de"] })]);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/scrape_status = CASE WHEN COALESCE\(array_length\(lead_results\.emails, 1\), 0\) = 0/);
    expect(sql).toMatch(/AND COALESCE\(array_length\(EXCLUDED\.emails, 1\), 0\) > 0/);
    expect(sql).toMatch(/THEN 'found' ELSE lead_results\.scrape_status END/);
  });

  test("does not touch the search a lead was first found by", async () => {
    await persistResults("s1", "ws1", [business()]);
    const [sql] = query.mock.calls[0];
    expect(sql).not.toMatch(/SET[\s\S]*search_id/);
  });

  test("still writes nothing at all for an empty batch", async () => {
    await expect(persistResults("s1", "ws1", [])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
