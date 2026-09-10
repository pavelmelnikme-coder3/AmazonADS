"use strict";
/**
 * The DNS gate on stored addresses.
 *
 * 98 of the 1,939 domains in the asian_b2b audience resolve to nothing at all, so every address
 * at one of them is a guaranteed hard bounce — and hard bounces are the number that gets a
 * sending account suspended (Brevo acts around 5%; the July campaign came in at 6.3%).
 *
 * Two of those domains are damage no character-level rule can see, because the wreckage is
 * still shaped like a domain: `asia-thaigourmet-bonner-str.deinfo` is ".de" glued to the word
 * that followed it in the HTML, and `berliner-pilsner.den` is ".de" plus a stray "n". Both pass
 * every syntax check there is. DNS is what separates them from a real domain.
 *
 * The rule that matters most here is the one about failing OPEN: a resolver timing out says
 * nothing about the domain, and dropping a paid-for lead over a DNS blip is the worse error.
 */
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("dns", () => ({ promises: { resolveMx: jest.fn(), resolve4: jest.fn(), resolve6: jest.fn() } }));

// resetModules re-runs the jest.mock factories, so a reference taken at the top of the file
// would point at a previous generation of the dns mock while the module under test calls the
// new one. Every reference is therefore re-acquired after each reset.
let dns;

const err = (code) => Object.assign(new Error(code), { code });
const NXDOMAIN = () => Promise.reject(err("ENOTFOUND"));
const NODATA = () => Promise.reject(err("ENODATA"));
const SERVFAIL = () => Promise.reject(err("SERVFAIL"));
const TIMEOUT = () => Promise.reject(err("ETIMEOUT"));

let mx;
beforeEach(() => {
  jest.resetModules();
  dns = require("dns").promises;
  mx = require("../src/services/email/mx");
});

describe("acceptsMail", () => {
  test("an MX record is enough", async () => {
    dns.resolveMx.mockResolvedValue([{ exchange: "mx.site.de", priority: 10 }]);
    expect(await mx.acceptsMail("site.de")).toBe(true);
    expect(dns.resolve4).not.toHaveBeenCalled();
  });

  // RFC 5321 §5.1: with no MX, the address record is the implicit mail exchanger. Plenty of
  // small restaurant domains are hosted this way and do accept mail.
  test("no MX but an A record still accepts mail", async () => {
    dns.resolveMx.mockImplementation(NODATA);
    dns.resolve4.mockResolvedValue(["1.2.3.4"]);
    expect(await mx.acceptsMail("site.de")).toBe(true);
  });

  test("no MX, no A, but AAAA still accepts mail", async () => {
    dns.resolveMx.mockImplementation(NODATA);
    dns.resolve4.mockImplementation(NODATA);
    dns.resolve6.mockResolvedValue(["2a01::1"]);
    expect(await mx.acceptsMail("site.de")).toBe(true);
  });

  test("a domain that does not exist is rejected", async () => {
    dns.resolveMx.mockImplementation(NXDOMAIN);
    dns.resolve4.mockImplementation(NXDOMAIN);
    dns.resolve6.mockImplementation(NXDOMAIN);
    expect(await mx.acceptsMail("berliner-pilsner.den")).toBe(false);
  });

  test("an empty MX answer is not an answer", async () => {
    dns.resolveMx.mockResolvedValue([]);
    dns.resolve4.mockImplementation(NXDOMAIN);
    dns.resolve6.mockImplementation(NXDOMAIN);
    expect(await mx.acceptsMail("site.de")).toBe(false);
  });

  // The whole point: a resolver problem must never cost a real lead.
  test.each([["SERVFAIL", SERVFAIL], ["a timeout", TIMEOUT]])(
    "%s fails open — the address is kept", async (_label, mode) => {
      dns.resolveMx.mockImplementation(mode);
      expect(await mx.acceptsMail("site.de")).toBe(true);
    });

  test("an authoritative no-MX followed by a SERVFAIL on A also fails open", async () => {
    dns.resolveMx.mockImplementation(NODATA);
    dns.resolve4.mockImplementation(SERVFAIL);
    expect(await mx.acceptsMail("site.de")).toBe(true);
  });

  test("each domain is resolved once, however many addresses share it", async () => {
    dns.resolveMx.mockResolvedValue([{ exchange: "mx.gmail.com", priority: 10 }]);
    await mx.acceptsMail("gmail.com");
    await mx.acceptsMail("gmail.com");
    await mx.acceptsMail("GMAIL.COM");
    expect(dns.resolveMx).toHaveBeenCalledTimes(1);
  });

  test("an empty domain is not accepted", async () => {
    expect(await mx.acceptsMail("")).toBe(false);
    expect(dns.resolveMx).not.toHaveBeenCalled();
  });
});

describe("partitionByMx", () => {
  test("splits a mixed list and names the dead domains", async () => {
    dns.resolveMx.mockImplementation((d) =>
      d === "9drachen.de" ? Promise.resolve([{ exchange: "mx", priority: 10 }]) : NXDOMAIN());
    dns.resolve4.mockImplementation(NXDOMAIN);
    dns.resolve6.mockImplementation(NXDOMAIN);

    const { deliverable, deadDomains } = await mx.partitionByMx([
      "info@9drachen.de", "kontakt@9drachen.de", "info@berliner-pilsner.den",
    ]);
    expect([...deliverable].sort()).toEqual(["info@9drachen.de", "kontakt@9drachen.de"]);
    expect(deadDomains).toEqual(["berliner-pilsner.den"]);
  });

  test("an empty list asks DNS nothing", async () => {
    const { deliverable, deadDomains } = await mx.partitionByMx([]);
    expect(deliverable.size).toBe(0);
    expect(deadDomains).toEqual([]);
    expect(dns.resolveMx).not.toHaveBeenCalled();
  });
});

describe("insertContacts with the gate on", () => {
  let insertContacts, dbQuery;
  beforeEach(() => {
    jest.resetModules();
    jest.doMock("../src/db/pool", () => ({ query: jest.fn().mockResolvedValue({ rows: [{ inserted: true }] }) }));
    dns = require("dns").promises;
    dbQuery = require("../src/db/pool").query;
    ({ insertContacts } = require("../src/services/email/contacts"));
  });

  test("an address at a dead domain never reaches the INSERT, and is reported by reason", async () => {
    dns.resolveMx.mockImplementation((d) =>
      d === "live.de" ? Promise.resolve([{ exchange: "mx", priority: 10 }]) : NXDOMAIN());
    dns.resolve4.mockImplementation(NXDOMAIN);
    dns.resolve6.mockImplementation(NXDOMAIN);

    const r = await insertContacts("ws1",
      [{ email: "info@live.de" }, { email: "info@dead.de" }], "scraped_public_website", "lead_finder", null,
      { verifyMx: true });

    expect(r.imported).toBe(1);
    expect(r.invalid).toBe(1);
    expect(r.rejected).toEqual({ no_mail_exchanger: 1 });
    expect(dbQuery).toHaveBeenCalledTimes(1);
    expect(dbQuery.mock.calls[0][1][1]).toBe("info@live.de");
  });

  // Junk is rejected on shape before any lookup happens — no point spending a DNS query on
  // an npm package spec.
  test("a malformed address costs no DNS lookup", async () => {
    dns.resolveMx.mockResolvedValue([{ exchange: "mx", priority: 10 }]);
    const r = await insertContacts("ws1", [{ email: "alpinejs@3.x.x" }], "import", "import", null,
      { verifyMx: true });
    expect(r.rejected).toEqual({ bad_shape: 1 });
    expect(dns.resolveMx).not.toHaveBeenCalled();
  });

  test("with the gate off, DNS is never consulted", async () => {
    await insertContacts("ws1", [{ email: "info@whatever.de" }], "import", "import", null);
    expect(dns.resolveMx).not.toHaveBeenCalled();
  });
});
