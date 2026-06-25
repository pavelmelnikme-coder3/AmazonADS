/**
 * Amazon SES v2 adapter for marketing/bulk email.
 *
 * Env:
 *   SES_REGION              (default eu-central-1 — Frankfurt, EU/GDPR)
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   (omit to use the default AWS credential chain)
 *   SES_FROM_EMAIL          (configured signal — see isConfigured())
 *   SES_CONFIGURATION_SET   (event publishing → SNS; bounce/complaint suppression)
 *
 * We render the final HTML per recipient (merge tags + footer already applied upstream), so each
 * message is sent as Raw MIME — that's what lets us attach the per-recipient RFC 8058
 * List-Unsubscribe headers (SES v2 Simple content can't carry custom headers). SES throttles by
 * messages/sec regardless of single-vs-bulk, so the queue-level limiter is the real rate guard;
 * here we just bound HTTP concurrency so a few thousand messages drain quickly.
 *
 * isConfigured() gates all sends: with no creds/from the app still works — sends return a clear
 * "not configured" result instead of throwing.
 */
const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");
const logger = require("../../config/logger");
const { unsubscribeUrl } = require("./render");

let _client = null;
function client() {
  if (_client) return _client;
  const region = process.env.SES_REGION || "eu-central-1";
  const creds = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
    : undefined; // default AWS credential provider chain (IAM role, etc.)
  _client = new SESv2Client({ region, ...(creds ? { credentials: creds } : {}) });
  return _client;
}

function isConfigured() {
  return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.SES_FROM_EMAIL);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// RFC 2047 encoded-word for non-ASCII subjects (umlauts etc. survive transport).
function encodeMimeWord(s) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s || "")) return s || "";
  return `=?UTF-8?B?${Buffer.from(s, "utf-8").toString("base64")}?=`;
}

// Build a Raw MIME SendEmailCommand carrying the per-recipient List-Unsubscribe headers.
function buildRawCommand({ from, replyTo, configurationSet, subject, html, toEmail, unsubscribeToken }) {
  const unsub = unsubscribeUrl(unsubscribeToken);
  const headers = [
    `From: ${from}`,
    `To: ${toEmail}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeMimeWord(subject)}`,
    `MIME-Version: 1.0`,
    `List-Unsubscribe: <${unsub}>`,
    `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: 8bit`,
  ].filter(Boolean).join("\r\n");
  const raw = `${headers}\r\n\r\n${html}`;
  return new SendEmailCommand({
    FromEmailAddress: from,
    ReplyToAddresses: replyTo ? [replyTo] : undefined,
    ConfigurationSetName: configurationSet || undefined,
    Destination: { ToAddresses: [toEmail] },
    Content: { Raw: { Data: Buffer.from(raw, "utf-8") } },
  });
}

/**
 * Send a list of fully-rendered, per-recipient emails (concurrency-bounded).
 * @param {object} p
 * @param {string} p.fromEmail
 * @param {string} [p.fromName]
 * @param {string} [p.replyTo]
 * @param {string} [p.configurationSet]
 * @param {Array}  p.entries  - [{ email, subject, html, unsubscribeToken }]
 * @param {number} [p.concurrency=10]
 * @returns {Promise<Array<{email,messageId,status,error}>>}
 */
async function sendBulkEmail({ fromEmail, fromName, replyTo, configurationSet, entries, concurrency = 10 }) {
  if (!isConfigured()) {
    return entries.map((e) => ({ email: e.email, messageId: null, status: "failed", error: "SES not configured" }));
  }
  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const results = [];
  for (const group of chunk(entries, concurrency)) {
    const settled = await Promise.all(group.map(async (e) => {
      try {
        const out = await client().send(buildRawCommand({
          from, replyTo, configurationSet,
          subject: e.subject, html: e.html, toEmail: e.email, unsubscribeToken: e.unsubscribeToken,
        }));
        return { email: e.email, messageId: out.MessageId, status: "sent", error: null };
      } catch (err) {
        logger.warn("SES send failed", { email: e.email, error: err.message });
        return { email: e.email, messageId: null, status: "failed", error: err.message };
      }
    }));
    results.push(...settled);
  }
  return results;
}

module.exports = { isConfigured, sendBulkEmail, _internal: { chunk, encodeMimeWord, buildRawCommand } };
