"use strict";
/**
 * Where the compliance footer ends up in the author's HTML.
 *
 * Campaign bodies in this project are complete HTML documents — the asian_b2b body is 19,012
 * characters ending in `</body></html>` — and the footer was concatenated onto the end of the
 * string, which put it outside the document: outside the 600px centred table the rest of the
 * email lives in, and dependent on what each client does with trailing content. It carries the
 * postal address German law requires and the only visible unsubscribe link in the message, and
 * that body's own text promises "Den Abmeldelink finden Sie am Ende dieser Nachricht".
 */
const { renderHtmlForContact, injectFooter } = require("../src/services/email/render");

const CONTACT = { email: "a@b.de", first_name: "", last_name: "", attributes: {},
                  consent_source: "scraped_public_website", unsubscribe_token: "TOK" };

beforeAll(() => {
  process.env.APP_PUBLIC_URL = "https://mail.example.com";
  process.env.COMPANY_POSTAL_ADDRESS = "West & East GmbH, Hannover";
  process.env.MAIL_DEFAULT_LOCALE = "de";
});

describe("injectFooter", () => {
  test("a full document gets the footer inside </body>", () => {
    const out = injectFooter("<html><body><p>Hi</p></body></html>", "[F]");
    expect(out).toBe("<html><body><p>Hi</p>[F]</body></html>");
  });

  test("a document with no </body> falls back to inside </html>", () => {
    expect(injectFooter("<html><p>Hi</p></html>", "[F]")).toBe("<html><p>Hi</p>[F]</html>");
  });

  test("a fragment (the block editor's output) still gets it appended", () => {
    expect(injectFooter("<p>Hi</p>", "[F]")).toBe("<p>Hi</p>[F]");
  });

  test("matching is case-insensitive — </BODY> counts", () => {
    expect(injectFooter("<HTML><BODY>Hi</BODY></HTML>", "[F]")).toBe("<HTML><BODY>Hi[F]</BODY></HTML>");
  });

  // A body that shows escaped markup in its own copy must not pull the footer into the middle
  // of the message; the real closing tag is the last one.
  test("the LAST closing tag wins", () => {
    const out = injectFooter("<body>see &lt;/body&gt; written out<p>end</p></body>", "[F]");
    expect(out).toBe("<body>see &lt;/body&gt; written out<p>end</p>[F]</body>");
  });
});

describe("renderHtmlForContact on a real full-document body", () => {
  const body = `<html><head><title>T</title></head><body style="background:#eef1f3;">
    <table><tr><td>Angebot</td></tr></table></body></html>`;
  // Rendered per test, not once in the describe body: the describe body runs before beforeAll,
  // so MAIL_DEFAULT_LOCALE would not be set yet and the footer would come out in English.
  let html;
  beforeEach(() => { html = renderHtmlForContact(body, CONTACT, { campaignId: "camp1" }); });

  test("the unsubscribe link is inside the document, not trailing after </html>", () => {
    const unsubAt = html.indexOf("/api/v1/email/unsubscribe/TOK");
    expect(unsubAt).toBeGreaterThan(-1);
    expect(unsubAt).toBeLessThan(html.toLowerCase().lastIndexOf("</body>"));
    expect(unsubAt).toBeLessThan(html.toLowerCase().lastIndexOf("</html>"));
  });

  test("the postal address is inside the document too", () => {
    expect(html.indexOf("West &amp; East GmbH, Hannover"))
      .toBeLessThan(html.toLowerCase().lastIndexOf("</body>"));
  });

  test("nothing is left dangling after </html>", () => {
    expect(html.slice(html.toLowerCase().lastIndexOf("</html>") + 7).trim()).toBe("");
  });

  test("the footer is a width-constrained table, like the rest of the email", () => {
    expect(html).toMatch(/<table[^>]*role="presentation"/);
    expect(html).toMatch(/width="600"/);
  });

  test("the body's own content still renders and is untouched", () => {
    expect(html).toContain("<table><tr><td>Angebot</td></tr></table>");
  });

  // The body is German and the contact was collected from a published website, so the footer
  // has to say where the address came from rather than assert an opt-in (see emailModuleAudit).
  test("it still speaks German and still does not claim consent", () => {
    expect(html).toContain("Geschäftsadresse");
    expect(html).not.toContain("angemeldet haben");
    expect(html).toMatch(/Abmelden/);
  });
});
