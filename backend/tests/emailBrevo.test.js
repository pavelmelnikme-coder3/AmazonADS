"use strict";
/**
 * Brevo SMTP-relay adapter — isConfigured gate, List-Unsubscribe headers, quota-vs-failure
 * classification, and (new) attachments passthrough for true SMTP attachments.
 */
const mockSentMail = [];
let mockNextResult = () => ({ messageId: "m-" + (mockSentMail.length + 1) });
jest.mock("nodemailer", () => ({
  createTransport: () => ({
    sendMail: jest.fn((opts) => {
      mockSentMail.push(opts);
      const r = mockNextResult();
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r);
    }),
  }),
}));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

beforeAll(() => {
  process.env.APP_PUBLIC_URL = "https://mail.adsflow.app";
  process.env.BREVO_SMTP_LOGIN = "login";
  process.env.BREVO_SMTP_KEY = "key";
  process.env.MAIL_FROM_EMAIL = "from@x.com";
});
beforeEach(() => { mockSentMail.length = 0; mockNextResult = () => ({ messageId: "m-" + (mockSentMail.length + 1) }); });

const brevo = require("../src/services/email/brevo");

test("isConfigured true once creds + from are set", () => {
  expect(brevo.isConfigured()).toBe(true);
});

test("sendBulkEmail omits attachments key when none provided", async () => {
  const out = await brevo.sendBulkEmail({
    fromEmail: "from@x.com", entries: [{ email: "a@b.com", subject: "s", html: "h", unsubscribeToken: "t1" }],
  });
  expect(out[0].status).toBe("sent");
  expect(mockSentMail[0].attachments).toBeUndefined();
});

test("sendBulkEmail forwards attachments unchanged to every sendMail call", async () => {
  const attachments = [{ filename: "price-list.pdf", path: "/tmp/price-list.pdf" }];
  const entries = [
    { email: "a@b.com", subject: "s1", html: "h1", unsubscribeToken: "t1" },
    { email: "c@d.com", subject: "s2", html: "h2", unsubscribeToken: "t2" },
  ];
  const out = await brevo.sendBulkEmail({ fromEmail: "from@x.com", entries, attachments });
  expect(out.every((r) => r.status === "sent")).toBe(true);
  expect(mockSentMail).toHaveLength(2);
  expect(mockSentMail[0].attachments).toEqual(attachments);
  expect(mockSentMail[1].attachments).toEqual(attachments);
});

test("List-Unsubscribe headers are set per recipient", async () => {
  await brevo.sendBulkEmail({ fromEmail: "from@x.com", entries: [{ email: "a@b.com", subject: "s", html: "h", unsubscribeToken: "TK" }] });
  expect(mockSentMail[0].headers["List-Unsubscribe"]).toBe("<https://mail.adsflow.app/api/v1/email/unsubscribe/TK>");
  expect(mockSentMail[0].headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
});

test("sendId sets X-Mailin-Tag (Brevo echoes it back on webhook events for correlation)", async () => {
  await brevo.sendBulkEmail({
    fromEmail: "from@x.com",
    entries: [{ email: "a@b.com", subject: "s", html: "h", unsubscribeToken: "t1", sendId: "send-row-42" }],
  });
  expect(mockSentMail[0].headers["X-Mailin-Tag"]).toBe("send-row-42");
});

test("no sendId (e.g. one-off test sends) → no X-Mailin-Tag header sent at all", async () => {
  await brevo.sendBulkEmail({ fromEmail: "from@x.com", entries: [{ email: "a@b.com", subject: "s", html: "h", unsubscribeToken: "t1" }] });
  expect(mockSentMail[0].headers["X-Mailin-Tag"]).toBeUndefined();
});

test("quota-looking errors classify as 'deferred', others as 'failed'", async () => {
  let call = 0;
  mockNextResult = () => { call++; return call === 1 ? Object.assign(new Error("Daily sending quota exceeded"), {}) : new Error("mailbox not found"); };
  const out = await brevo.sendBulkEmail({
    fromEmail: "from@x.com",
    entries: [
      { email: "a@b.com", subject: "s", html: "h", unsubscribeToken: "t1" },
      { email: "b@b.com", subject: "s", html: "h", unsubscribeToken: "t2" },
    ],
  });
  const byEmail = Object.fromEntries(out.map((r) => [r.email, r.status]));
  expect(byEmail["a@b.com"]).toBe("deferred");
  expect(byEmail["b@b.com"]).toBe("failed");
});
