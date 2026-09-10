"use strict";
/**
 * The address gate, written against what actually reached production.
 *
 * The asian_b2b audience — 3,248 addresses harvested from restaurant websites — carried 33
 * entries that were not addresses of a business. Two gates were supposed to stop them and
 * neither did: the scraper's `isJunkEmail` let a 1-character TLD through, and the import
 * path's `isEmail` was `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, which accepts anything containing "@".
 * Every literal below is a string taken from that audience.
 */
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { classifyAddress, normalizeAddress, hasDeliverableShape } = require("../src/services/email/address");
const { extractEmails } = require("../src/services/leadFinder/emailScraper");

describe("addresses that are real but arrived wearing markup", () => {
  // These four are live mailboxes at real restaurants. The old behaviour was to keep the
  // stray character and mail `'impressum@…`, which no MTA will deliver — so the lead was
  // paid for, stored, counted in the audience, and then lost at the SMTP door.
  test.each([
    ["'impressum@asia-lieferservice-bayreuth.de", "impressum@asia-lieferservice-bayreuth.de"],
    ["'shw@asia-bayreuth.de", "shw@asia-bayreuth.de"],
    ["'vietvina@gmx.de", "vietvina@gmx.de"],
    ["#buchhaltung@kinhdo-gmbh.de", "buchhaltung@kinhdo-gmbh.de"],
  ])("%s is repaired, not discarded", (raw, expected) => {
    const r = classifyAddress(raw);
    expect(r.ok).toBe(true);
    expect(r.email).toBe(expected);
  });

  test("a mailto: href with a subject querystring yields just the address", () => {
    expect(normalizeAddress("mailto:Info@Site.DE?subject=Hallo%20Welt")).toBe("info@site.de");
  });

  test("an address wrapped in angle brackets or quotes unwraps", () => {
    expect(normalizeAddress("<info@site.de>")).toBe("info@site.de");
    expect(normalizeAddress('"kontakt@site.de"')).toBe("kontakt@site.de");
  });

  test("a trailing dot off a sentence is trimmed from the domain", () => {
    expect(normalizeAddress("Schreiben Sie an info@site.de.".split(" ").pop())).toBe("info@site.de");
  });
});

describe("strings that are not addresses at all", () => {
  test.each([
    ["alpinejs@3.x.x", "bad_shape"],            // npm package spec out of a <script> tag
    ["s*q@0.l", "bad_shape"],                   // two fragments of minified CSS around an @
    ["info@chichikan.d", "bad_shape"],          // a truncated .de
    ["leaflet@1.0.0-rc.3", "bad_shape"],        // CDN version with a letter in the pre-release tag
    ["swiper@8.4.5", "bad_shape"],
    // A WhatsApp group JID from a chat widget. Two rules would each reject it — the numeric
    // local part and g.us being on the vendor list — and the numeric one is the more precise
    // description, so that is the reason reported.
    ["120363406267552979@g.us", "numeric_id"],
    ["privacyquestions@cloudflare.com", "vendor_domain"],
    ["privacy@fontawesome.com", "vendor_domain"],
    ["dpo@wordpress.org", "vendor_domain"],
    ["example@mysite.com", "placeholder_domain"],
    ["info@mysite.com", "placeholder_domain"],
    ["name@example.de", "placeholder_domain"],
    ["logo@2x.png", "file_name"],
    ["not-an-email", "unparseable"],
    // Found by rendering the campaign for its first real recipient, which turned out to be a
    // free-HTML-template vendor. The same sweep had Spotify's privacy team (off an embedded
    // player), Deliveroo's French office, Readymag's no-reply, and two developers' own domains.
    ["info@freehtml5.co", "vendor_domain"],
    ["privacy@spotify.com", "vendor_domain"],
    ["hello@deliveroo.fr", "vendor_domain"],
    ["webmaster@gourmetguide.com", "vendor_domain"],
    ["no-reply@readymag.com", "vendor_domain"],
    ["beispiel@beispiel.com", "placeholder_domain"],
    ["name@beispiel.de", "placeholder_domain"],
    ["youremail@gmail.com", "unreachable_local"],
    // The German placeholder family, found by rendering the campaign for the first recipient in
    // the audience twice over and getting a template address both times.
    ["ihre@email.de", "unreachable_local"],
    ["deine@email.de", "unreachable_local"],
    ["andere@email.de", "unreachable_local"],
    ["max.mustermann@gmail.com", "unreachable_local"],
    ["you@company.com", "placeholder_domain"],
    ["noreply@sushi-yakumi.de", "unreachable_local"],
    ["postmaster@sushi-yakumi.de", "unreachable_local"],
  ])("%s is rejected as %s", (raw, reason) => {
    const r = classifyAddress(raw);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(reason);
  });

  test("a numeric local part long enough to be a chat id or phone number is rejected", () => {
    expect(classifyAddress("120363406267552979@some-restaurant.de").reason).toBe("numeric_id");
  });

  // QQ mailboxes are genuinely all-digits and the list holds Chinese providers, so the
  // numeric rule has to sit well above their length rather than rejecting digits outright.
  test("a QQ-style numeric address is still accepted", () => {
    expect(classifyAddress("876543210@qq.com").ok).toBe(true);
  });

  // 163.com and 126.com are real mailbox providers whose second-level label is numeric. A
  // "domain starts with digits → version string" rule would have silently dropped 5 contacts;
  // it is the *last* label being non-alphabetic that marks a version.
  test.each(["rotesonne@163.com", "limingchen2009@126.com"])("%s survives", (email) => {
    expect(classifyAddress(email).ok).toBe(true);
  });

  // The vendor list is matched on whole labels, never as a substring: a keyword scan for
  // "seo" over these domains flagged six Korean restaurants, every one of them a real prospect.
  test.each(["info@littleseoul.de", "info@seoul-kitchen.net", "info@seoulbap-kiel.de",
             "info@seoulbynight.de", "info@seoulful.de", "info@seoulkitchen.de"])(
    "%s is a restaurant, not a vendor", (email) => {
      expect(classifyAddress(email).ok).toBe(true);
    });

  // A small restaurant's one real mailbox is often admin@ or webmaster@. Those must survive;
  // only mailboxes nobody reads (no-reply, postmaster) and template placeholders are rejected.
  test.each(["admin@nuttsthaikitchen.de", "webmaster@haimaisgarten.de", "zentrale@9drachen.de"])(
    "%s is kept — it may be the only inbox they read", (email) => {
      expect(classifyAddress(email).ok).toBe(true);
    });

  // email.de and mail.de are real German mailbox providers, and eight restaurants in this list
  // use them. Only the pronoun in the local part marks a template, never the domain.
  test.each(["tokiosushi@mail.de", "silk-road@mail.de", "thang_long@mail.de",
             "roschis.schlemmerkantine@mail.de", "viengkham@mail.de"])(
    "%s is a real restaurant at a real provider", (email) => {
      expect(classifyAddress(email).ok).toBe(true);
    });

  // Odd TLDs are a domain hack, not damage: hokkai.do spells "Hokkaido".
  test.each(["info@hokkai.do", "mail@dimsum.haus", "info@ikigai.menu", "hello@usagi.bar",
             "info@meithai.saarland", "garching@freiraum.rest", "info@umami.ms"])(
    "%s survives — the TLD is the joke, not a typo", (email) => {
      expect(classifyAddress(email).ok).toBe(true);
    });

  test("ordinary business addresses are untouched", () => {
    for (const e of ["info@9drachen.de", "kontakt@957ramenbar.de", "reservation@89anju.de",
                     "o'brien@pub-hannover.de", "vorname.nachname+gastro@web.de"]) {
      expect(classifyAddress(e)).toEqual({ email: e, ok: true, reason: null });
    }
  });
});

describe("hasDeliverableShape", () => {
  test("rejects consecutive dots, edge dots and a missing TLD", () => {
    expect(hasDeliverableShape("a..b@site.de")).toBe(false);
    expect(hasDeliverableShape(".a@site.de")).toBe(false);
    expect(hasDeliverableShape("a.@site.de")).toBe(false);
    expect(hasDeliverableShape("a@site")).toBe(false);
  });

  test("rejects a local part over 64 chars and an address over 254", () => {
    expect(hasDeliverableShape(`${"a".repeat(65)}@site.de`)).toBe(false);
    const longDomain = Array.from({ length: 5 }, (_, i) => String.fromCharCode(98 + i).repeat(60)).join(".");
    expect(`a@${longDomain}.de`.length).toBeGreaterThan(254);
    expect(hasDeliverableShape(`a@${longDomain}.de`)).toBe(false);
  });
});

describe("the scraper uses the same gate", () => {
  // The page shapes these came from: a JS string literal, a CDN script tag, a cookie banner,
  // and a plain contact line.
  const html = `
    <script src="https://cdn.example.com/alpinejs@3.x.x/dist/cdn.min.js"></script>
    <script>var m='impressum@asia-lieferservice-bayreuth.de';</script>
    <p>Fragen zum Datenschutz: privacyquestions@cloudflare.com</p>
    <a href="mailto:info@9drachen.de">Kontakt</a>
    <img src="logo@2x.png">
  `;

  test("keeps the repaired business addresses and nothing else", () => {
    expect(extractEmails(html).sort()).toEqual(
      ["impressum@asia-lieferservice-bayreuth.de", "info@9drachen.de"]);
  });
});
