"use strict";
/**
 * `{{ unsubscribe }}` and `{{ mirror }}` are merge tags.
 *
 * They were not. `applyMergeTags` substituted contact fields only, so the templates in this
 * project — which use both — collapsed them to the empty string and shipped `href=""`. The one
 * campaign sent so far reached 1070 recipients with two dead links, and there was no mirror
 * route behind the tag either.
 */
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { contactFields, renderHtmlForContact, unsubscribeUrl, mirrorUrl, publicBase } =
  require("../src/services/email/render");

const CONTACT = { email: "a@b.de", first_name: "Sam", attributes: {}, unsubscribe_token: "TOK123" };
const TEMPLATE = '<a href="{{ mirror }}">browser</a><a href="{{ unsubscribe }}">out</a><p>{{ first_name }}</p>';

const withEnv = (env, fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try { return fn(); } finally { process.env = saved; }
};

describe("the tags the templates actually use now resolve", () => {
  test("neither collapses to an empty href", () => {
    const out = withEnv({ APP_PUBLIC_URL: "https://ads.example" },
      () => renderHtmlForContact(TEMPLATE, CONTACT, { campaignId: "camp-1" }));
    expect(out).not.toMatch(/href=""/);
    expect(out).toContain("https://ads.example/api/v1/email/unsubscribe/TOK123");
    expect(out).toContain("https://ads.example/api/v1/email/campaigns/camp-1/mirror/TOK123");
    expect(out).toContain("Sam");
  });

  test("the real campaign template no longer ships dead links", () => {
    // Shape of the B2B campaign that went out on 2026-07-01.
    const real = '<td><a href="{{ mirror }}">Im Browser öffnen</a></td>'
               + '<td><a href="{{ unsubscribe }}">Abmelden</a></td>';
    const out = withEnv({ APP_PUBLIC_URL: "https://ads.example" },
      () => renderHtmlForContact(real, CONTACT, { campaignId: "camp-1" }));
    expect((out.match(/href=""/g) || [])).toHaveLength(0);
  });

  test("an unknown tag still collapses — a missing field must never leak '{{x}}'", () => {
    const out = renderHtmlForContact("<p>{{ nope }}</p>", CONTACT, {});
    expect(out).not.toMatch(/\{\{/);
  });
});

describe("a contact attribute cannot hijack the opt-out link", () => {
  test("an `unsubscribe` attribute does not shadow the real URL", () => {
    const f = contactFields(
      { ...CONTACT, attributes: { unsubscribe: "https://evil.example/hijack" } }, { campaignId: "c1" });
    expect(f.unsubscribe).not.toContain("evil.example");
    expect(f.unsubscribe).toContain("TOK123");
  });

  test("a `mirror` attribute cannot either", () => {
    const f = contactFields({ ...CONTACT, attributes: { mirror: "https://evil.example" } }, { campaignId: "c1" });
    expect(f.mirror).not.toContain("evil.example");
  });
});

describe("public link base", () => {
  test("APP_PUBLIC_URL wins and its trailing slash is dropped", () => {
    expect(withEnv({ APP_PUBLIC_URL: "https://a.example/" }, publicBase)).toBe("https://a.example");
  });

  test("FRONTEND_URL stands in — a host-less relative URL is a dead link and an invalid List-Unsubscribe", () => {
    expect(withEnv({ APP_PUBLIC_URL: "", FRONTEND_URL: "http://1.2.3.4:3000" }, publicBase))
      .toBe("http://1.2.3.4:3000");
  });

  test("mirror needs both a campaign and a token, else it renders nothing rather than a broken link", () => {
    expect(mirrorUrl("", "tok")).toBe("");
    expect(mirrorUrl("camp", "")).toBe("");
  });

  test("the token is URL-encoded into the unsubscribe link", () => {
    expect(withEnv({ APP_PUBLIC_URL: "https://a.example" }, () => unsubscribeUrl("a/b?c")))
      .toContain("a%2Fb%3Fc");
  });
});

describe("the compliance footer speaks the recipient's language", () => {
  // It is the one part of a marketing email this code writes rather than the campaign author,
  // and it shipped hardcoded English under a German campaign.
  const { resolveLocale } = require("../src/services/email/render");
  const de = { ...CONTACT, attributes: { locale: "de-DE" } };

  test("an explicit locale wins", () => {
    expect(renderHtmlForContact("<p/>", CONTACT, { locale: "de" })).toContain("Abmelden");
    expect(renderHtmlForContact("<p/>", CONTACT, { locale: "ru" })).toContain("Отписаться");
  });

  test("a contact's own locale attribute is used when the caller says nothing", () => {
    expect(renderHtmlForContact("<p/>", de, {})).toContain("Sie erhalten diese E-Mail");
  });

  test("`lang` works as well as `locale`", () => {
    expect(resolveLocale({ attributes: { lang: "ru" } }, {})).toBe("ru");
  });

  test("a region suffix is tolerated", () => {
    expect(resolveLocale({ attributes: { locale: "de-AT" } }, {})).toBe("de");
  });

  test("the deployment default applies when the contact says nothing", () => {
    expect(withEnv({ MAIL_DEFAULT_LOCALE: "de" }, () => resolveLocale({ attributes: {} }, {}))).toBe("de");
  });

  test("an unknown language falls through to English rather than an empty footer", () => {
    expect(resolveLocale({ attributes: { locale: "xx" } }, {})).toBe("en");
    expect(renderHtmlForContact("<p/>", { ...CONTACT, attributes: { locale: "xx" } }, {}))
      .toContain("You are receiving this");
  });

  test("the test-send note is localised too", () => {
    expect(renderHtmlForContact("<p/>", CONTACT, { locale: "de", isTest: true })).toContain("Testsendungen");
  });

  test("a localised footer still carries a working unsubscribe link", () => {
    const out = withEnv({ APP_PUBLIC_URL: "https://a.example" },
      () => renderHtmlForContact("<p/>", de, {}));
    expect(out).toContain("https://a.example/api/v1/email/unsubscribe/TOK123");
    expect(out).not.toMatch(/href=""/);
  });
});

describe("a test send is a preview, so it must not reintroduce the dead link", () => {
  // The /test path renders with its own fake contact. It originally passed no campaignId, so
  // `{{ mirror }}` resolved to nothing and the one send used to CHECK the fix shipped the exact
  // `href=""` the fix removes.
  test("with a campaignId the mirror link is well-formed", () => {
    const out = withEnv({ APP_PUBLIC_URL: "https://a.example" },
      () => renderHtmlForContact('<a href="{{ mirror }}">b</a>', CONTACT, { isTest: true, campaignId: "camp-9" }));
    expect(out).not.toMatch(/href=""/);
    expect(out).toContain("/campaigns/camp-9/mirror/TOK123");
  });

  test("the footer note says BOTH links are inert, not just unsubscribe", () => {
    const out = renderHtmlForContact("<p/>", CONTACT, { isTest: true });
    expect(out).toMatch(/view-in-browser/i);
    expect(out).toMatch(/\[TEST\]/);
  });
});
