"use strict";
/**
 * Marketing email — render helpers + SES adapter.
 *   render: merge tags, missing-tag collapse, footer (postal address + unsubscribe link).
 *   ses:    isConfigured gate, batching, MIME subject encoding, List-Unsubscribe headers,
 *           and the not-configured short-circuit.
 */

// Capture the commands the SES client is asked to send.
const sentCommands = [];
jest.mock("@aws-sdk/client-sesv2", () => {
  class SendEmailCommand { constructor(input) { this.input = input; } }
  class SESv2Client {
    async send(cmd) { sentCommands.push(cmd); return { MessageId: "msg-" + sentCommands.length }; }
  }
  return { SESv2Client, SendEmailCommand };
});
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

beforeEach(() => { sentCommands.length = 0; jest.resetModules; });

describe("render", () => {
  const render = require("../src/services/email/render");
  beforeAll(() => { process.env.APP_PUBLIC_URL = "https://mail.adsflow.app"; process.env.COMPANY_POSTAL_ADDRESS = "West&East GmbH, Berlin"; });

  test("applyMergeTags fills known fields and collapses unknown to empty", () => {
    expect(render.applyMergeTags("Hi {{first_name}} {{nope}}!", { first_name: "Pavel" })).toBe("Hi Pavel !");
  });

  test("merge tags are HTML-escaped", () => {
    expect(render.applyMergeTags("{{x}}", { x: "<b>&" })).toBe("&lt;b&gt;&amp;");
  });

  test("unsubscribeUrl builds an https link under the public base", () => {
    expect(render.unsubscribeUrl("tok9")).toBe("https://mail.adsflow.app/api/v1/email/unsubscribe/tok9");
  });

  test("renderHtmlForContact appends postal address + unsubscribe footer", () => {
    const html = render.renderHtmlForContact("<p>Hello {{first_name}}</p>",
      { email: "a@b.com", first_name: "Ann", attributes: {}, unsubscribe_token: "T1" });
    expect(html).toContain("<p>Hello Ann</p>");
    expect(html).toContain("West&amp;East GmbH, Berlin");
    expect(html).toContain("/api/v1/email/unsubscribe/T1");
    expect(html).toMatch(/Unsubscribe/i);
  });
});

describe("ses adapter", () => {
  const ses = require("../src/services/email/ses");

  test("isConfigured false without creds", () => {
    delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AWS_SECRET_ACCESS_KEY; delete process.env.SES_FROM_EMAIL;
    expect(ses.isConfigured()).toBe(false);
  });

  test("sendBulkEmail short-circuits to failed when not configured (no AWS call)", async () => {
    const out = await ses.sendBulkEmail({ fromEmail: "x@y.com", entries: [{ email: "a@b.com", subject: "s", html: "h", unsubscribeToken: "t" }] });
    expect(out).toEqual([{ email: "a@b.com", messageId: null, status: "failed", error: "SES not configured" }]);
    expect(sentCommands).toHaveLength(0);
  });

  test("encodeMimeWord leaves ASCII, base64-encodes non-ASCII", () => {
    expect(ses._internal.encodeMimeWord("Hello")).toBe("Hello");
    expect(ses._internal.encodeMimeWord("Grüße")).toMatch(/^=\?UTF-8\?B\?.*\?=$/);
  });

  test("buildRawCommand injects RFC 8058 List-Unsubscribe headers", () => {
    process.env.APP_PUBLIC_URL = "https://mail.adsflow.app";
    const cmd = ses._internal.buildRawCommand({ from: "X <x@y.com>", subject: "Hi", html: "<p>h</p>", toEmail: "a@b.com", unsubscribeToken: "TK" });
    const raw = cmd.input.Content.Raw.Data.toString("utf-8");
    expect(raw).toContain("List-Unsubscribe: <https://mail.adsflow.app/api/v1/email/unsubscribe/TK>");
    expect(raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(raw).toContain("To: a@b.com");
  });

  test("sendBulkEmail sends one command per recipient and returns messageIds when configured", async () => {
    process.env.AWS_ACCESS_KEY_ID = "k"; process.env.AWS_SECRET_ACCESS_KEY = "s"; process.env.SES_FROM_EMAIL = "from@x.com";
    const entries = [
      { email: "a@b.com", subject: "s1", html: "h1", unsubscribeToken: "t1" },
      { email: "c@d.com", subject: "s2", html: "h2", unsubscribeToken: "t2" },
    ];
    const out = await ses.sendBulkEmail({ fromEmail: "from@x.com", fromName: "AdsFlow", entries });
    expect(out.map((r) => r.status)).toEqual(["sent", "sent"]);
    expect(out.every((r) => r.messageId)).toBe(true);
    expect(sentCommands).toHaveLength(2);
    delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AWS_SECRET_ACCESS_KEY; delete process.env.SES_FROM_EMAIL;
  });
});
