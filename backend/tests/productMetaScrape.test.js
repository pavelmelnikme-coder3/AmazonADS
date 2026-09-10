"use strict";
/**
 * The nightly product-meta scrape, and the two ways it wasted a paid quota.
 *
 * 276 of 551 active products have had no title since April. Every night the job re-fetched all
 * 276, and every night all 276 came back empty — 276 requests against a 1,000-request monthly
 * ScraperAPI plan, which empties the month's credits in four days. Rank tracking shares the same
 * key, so it went down with them: on the day this was found the account read
 * requestCount 1045 / requestLimit 1000, creditsLeft 0.
 *
 * Two separate faults made that possible:
 *   1. A 403 was recorded as a per-ASIN failure rather than the fetcher refusing us, so the loop
 *      walked the remaining 275 to be told the same thing 275 more times. Only a block *page*
 *      inside a 200 response stopped it.
 *   2. Nothing remembered that an ASIN had already come back empty, so the same dead list was
 *      retried nightly, forever.
 */
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("axios");

// resetModules re-runs the jest.mock factories, so the scraper closes over a *new* axios mock.
// References taken at the top of the file would configure the previous generation and the test
// would watch a mock nobody calls — re-acquire both together after every reset.
let axios, logger, scraper;
beforeEach(() => {
  jest.resetModules();
  process.env.SCRAPERAPI_KEY = "test-key";
  axios = require("axios");
  logger = require("../src/config/logger");
  scraper = require("../src/services/amazon/rankScraper");
});
afterAll(() => { delete process.env.SCRAPERAPI_KEY; });

const httpError = (status, body = "") =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: body } });

describe("a refusal from the fetcher is not a verdict on the ASIN", () => {
  test.each([
    [403, "You have exhausted the API Credits available in this monthly cycle."],
    [429, "Too Many Requests"],
    [503, "Service Unavailable"],
    [401, "Unauthorized"],
  ])("HTTP %i comes back as blocked, not as a per-ASIN failure", async (status, body) => {
    axios.get.mockRejectedValue(httpError(status, body));
    const r = await scraper.scrapeProductMeta("B000000001");
    expect(r.blocked).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  // A 404 really is about this ASIN — the page is gone — and must stay a per-ASIN failure, or
  // one dead product would halt the whole run.
  test("HTTP 404 stays a per-ASIN failure", async () => {
    axios.get.mockRejectedValue(httpError(404, "Not Found"));
    const r = await scraper.scrapeProductMeta("B000000002");
    expect(r.blocked).toBe(false);
    expect(r.error).toBeTruthy();
  });

  test("a network error with no HTTP status stays a per-ASIN failure", async () => {
    axios.get.mockRejectedValue(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    const r = await scraper.scrapeProductMeta("B000000003");
    expect(r.blocked).toBe(false);
  });
});

describe("syncProductsMeta stops at the first refusal", () => {
  // A fake db: records every query so the test can see what the job asked for and wrote.
  // isBlocked() treats anything under 5,000 characters as a block page, so a realistic-length
  // body is part of the fixture, not decoration.
  const pad = "<div>x</div>".repeat(600);

  function fakeDb(products) {
    const calls = [];
    return {
      calls,
      query: jest.fn(async (sql, params) => {
        calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
        if (/SELECT id, asin, marketplace_id FROM products/.test(sql)) return { rows: products };
        if (/meta_scrape_attempts = COALESCE/.test(sql)) return { rows: [{ meta_scrape_attempts: 1 }] };
        return { rows: [] };
      }),
    };
  }

  test("one 403 ends the run instead of asking 275 more times", async () => {
    const products = Array.from({ length: 276 }, (_, i) => ({ id: `p${i}`, asin: `B${i}`, marketplace_id: "A1PA6795UKMFR9" }));
    axios.get.mockRejectedValue(httpError(403, "credits exhausted"));
    const db = fakeDb(products);

    const r = await scraper.syncProductsMeta("ws1", db);

    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(r.blocked).toBe(1);
    expect(r.synced).toBe(0);
  });

  test("the query skips ASINs that have already come back empty too often", async () => {
    axios.get.mockResolvedValue({ data: `<html>${pad}</html>` });
    const db = fakeDb([]);
    await scraper.syncProductsMeta("ws1", db);
    const select = db.calls.find((c) => /SELECT id, asin/.test(c.sql));
    expect(select.sql).toMatch(/COALESCE\(meta_scrape_attempts, 0\) < \$2/);
    expect(select.params[1]).toBeGreaterThan(0);
  });

  test("an ASIN that answers with nothing spends one attempt", async () => {
    axios.get.mockResolvedValue({ data: `<html>no product here${pad}</html>` });
    const db = fakeDb([{ id: "p1", asin: "B1", marketplace_id: "A1PA6795UKMFR9" }]);
    await scraper.syncProductsMeta("ws1", db);
    expect(db.calls.some((c) => /meta_scrape_attempts = COALESCE\(meta_scrape_attempts, 0\) \+ 1/.test(c.sql))).toBe(true);
  });

  test("a successful fetch clears the counter", async () => {
    axios.get.mockResolvedValue({
      data: `<span id="productTitle"> EVOCAMP Butan 227g </span><img id="landingImage" src="https://img/x.jpg">${pad}`,
    });
    const db = fakeDb([{ id: "p1", asin: "B1", marketplace_id: "A1PA6795UKMFR9" }]);
    const r = await scraper.syncProductsMeta("ws1", db);
    expect(r.synced).toBe(1);
    const upd = db.calls.find((c) => /UPDATE products SET title/.test(c.sql));
    expect(upd.sql).toMatch(/meta_scrape_attempts=0/);
  });
});
