"use strict";
/**
 * Promoting leads into an audience.
 *
 * `added_to_contacts` records that a lead has been promoted at some point. It used to also
 * gate which leads were offered for promotion, which made a second promotion under a
 * different tag impossible: a lead promoted in July could never join an audience defined in
 * September. Found live on 2026-09-08 — "Sam Son Vietnam House", promoted under `asian` in
 * July, was matched again by the German sweep and silently left out of `asian_b2b`.
 *
 * Tags describe audiences and a lead can belong to several; the flag describes the lead.
 * So the flag is not the question this endpoint should be asking.
 */
const request = require("supertest");
const express = require("express");

const WS_ID = "ws---0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const SEARCH_ID = "srch-0001-0000-0000-000000000001";

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../src/services/email/contacts", () => ({ insertContacts: jest.fn() }));
jest.mock("../src/services/leadFinder/geocode", () => ({ geocodeRegion: jest.fn() }));
jest.mock("../src/services/leadFinder/overpass", () => ({ searchBusinesses: jest.fn() }));
jest.mock("../src/services/leadFinder/emailScraper", () => ({ fetchEmailsFromWebsite: jest.fn() }));
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => { req.user = { id: USER_ID }; next(); },
  requireWorkspace: (req, _res, next) => { req.workspaceId = WS_ID; next(); },
}));

const { query: dbQuery } = require("../src/db/pool");
const { insertContacts } = require("../src/services/email/contacts");
const router = require("../src/routes/leadFinder");

function app() {
  const a = express(); a.use(express.json()); a.use("/lead-finder", router);
  a.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return a;
}

// search lookup → candidates → already-added count → one UPDATE per promoted lead
function mockPromotionFlow(candidates) {
  dbQuery.mockReset();
  dbQuery
    .mockResolvedValueOnce({ rows: [{ region_query: "Bayern", business_query: "asiatisches restaurant" }] })
    .mockResolvedValueOnce({ rows: candidates })
    .mockResolvedValueOnce({ rows: [{ count: 0 }] })
    .mockResolvedValue({ rows: [] });
}

beforeEach(() => {
  jest.clearAllMocks();
  insertContacts.mockResolvedValue({ imported: 1, tagged: 0, skipped: 0, invalid: 0 });
});

describe("POST /searches/:id/add-to-contacts", () => {
  test("offers every lead that holds an address, promoted before or not", async () => {
    mockPromotionFlow([{ id: "l1", name: "Asia Wok", emails: ["a@wok.de"] }]);

    await request(app()).post(`/lead-finder/searches/${SEARCH_ID}/add-to-contacts`).send({ tag: "asian_b2b" });

    const [candidateSql] = dbQuery.mock.calls[1];
    expect(candidateSql).toMatch(/array_length\(emails, 1\) > 0/);
    expect(candidateSql).not.toMatch(/added_to_contacts = false/);
  });

  test("an address already on the list is reported as tagged, not as added or skipped", async () => {
    mockPromotionFlow([{ id: "l1", name: "Sam Son Vietnam House", emails: ["samson@yahoo.de"] }]);
    insertContacts.mockResolvedValue({ imported: 0, tagged: 1, skipped: 0, invalid: 0 });

    const res = await request(app())
      .post(`/lead-finder/searches/${SEARCH_ID}/add-to-contacts`).send({ tag: "asian_b2b" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ added: 0, tagged: 1, skipped_no_email: 0, tag: "asian_b2b" });
  });

  test("promotes under the tag the caller asked for", async () => {
    mockPromotionFlow([{ id: "l1", name: "Asia Wok", emails: ["a@wok.de"] }]);

    await request(app()).post(`/lead-finder/searches/${SEARCH_ID}/add-to-contacts`).send({ tag: "asian_b2b" });

    expect(insertContacts).toHaveBeenCalledWith(
      WS_ID, [{ email: "a@wok.de", first_name: "Asia Wok", tags: ["asian_b2b"] }],
      "scraped_public_website", "lead_finder", expect.anything(),
      // Scraped addresses get the DNS check: a published website is no guarantee the mailbox
      // on it still exists, and a dead domain is a certain hard bounce.
      { verifyMx: true }
    );
  });

  test("names where the address came from — never claims an opt-in", async () => {
    mockPromotionFlow([{ id: "l1", name: "Asia Wok", emails: ["a@wok.de"] }]);

    await request(app()).post(`/lead-finder/searches/${SEARCH_ID}/add-to-contacts`).send({});

    const [, , consentSource, consentMethod] = insertContacts.mock.calls[0];
    expect(consentSource).toBe("scraped_public_website");
    expect(consentMethod).toBe("lead_finder");
  });

  test("falls back to a tag derived from the search when none is given", async () => {
    mockPromotionFlow([{ id: "l1", name: "Asia Wok", emails: ["a@wok.de"] }]);

    const res = await request(app()).post(`/lead-finder/searches/${SEARCH_ID}/add-to-contacts`).send({});

    expect(res.body.tag).toBe("lead:bayern-asiatisches-restaurant");
  });

  test("404s for a search in another workspace", async () => {
    dbQuery.mockReset();
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app()).post(`/lead-finder/searches/${SEARCH_ID}/add-to-contacts`).send({});

    expect(res.status).toBe(404);
    expect(insertContacts).not.toHaveBeenCalled();
  });
});
