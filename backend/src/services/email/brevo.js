/**
 * Brevo (SMTP relay) adapter for marketing/bulk email — mirrors the ses.js interface so
 * dispatch.js can stay provider-agnostic.
 *
 * Why SMTP and not the Brevo REST campaign API: we render the final HTML per recipient
 * (merge tags + GDPR footer already applied upstream) and need to attach the per-recipient
 * RFC 8058 List-Unsubscribe headers. nodemailer over Brevo's SMTP relay carries arbitrary
 * headers, so one-click unsubscribe survives transport — same guarantee the SES path gives.
 *
 * Env:
 *   BREVO_SMTP_LOGIN / BREVO_SMTP_KEY   (same creds the transactional path in email.js uses)
 *   MAIL_FROM_EMAIL                     (verified sender/domain in Brevo; falls back to SES_FROM_EMAIL)
 *
 * isConfigured() gates sends: with no creds/from, sends return a clear "not configured" result
 * instead of throwing — the app keeps working, nothing silently disappears.
 *
 * Free-plan note: Brevo caps the ACCOUNT at 300 emails/day (marketing + transactional share it).
 * The daily budget is enforced by dispatch.dripSend(), NOT here. If a send is still rejected for
 * quota reasons we surface it as status:'deferred' so the caller re-queues it for the next day
 * instead of burning the recipient as a permanent failure.
 */
const nodemailer = require("nodemailer");
const logger = require("../../config/logger");
const { unsubscribeUrl } = require("./render");

let _transporter = null;
function transporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST || "smtp-relay.brevo.com",
    port: parseInt(process.env.BREVO_SMTP_PORT, 10) || 587,
    secure: false,
    auth: { user: process.env.BREVO_SMTP_LOGIN, pass: process.env.BREVO_SMTP_KEY },
  });
  return _transporter;
}

function fromEmailDefault() {
  return process.env.MAIL_FROM_EMAIL || process.env.SES_FROM_EMAIL || "";
}

function isConfigured() {
  return !!(process.env.BREVO_SMTP_LOGIN && process.env.BREVO_SMTP_KEY && fromEmailDefault());
}

// Provider-side signal that a send was rejected because the account ran out of daily quota
// (or is being rate-limited) — as opposed to a genuinely bad recipient. Such sends should be
// retried, not marked failed.
function isQuotaError(err) {
  const msg = `${err?.message || ""} ${err?.response || ""}`.toLowerCase();
  return /limit|quota|exceed|too many|rate|throttl|max .*reach/.test(msg);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Send a list of fully-rendered, per-recipient emails (concurrency-bounded).
 * @param {object} p
 * @param {string} p.fromEmail
 * @param {string} [p.fromName]
 * @param {string} [p.replyTo]
 * @param {Array}  p.entries  - [{ email, subject, html, unsubscribeToken }]
 * @param {number} [p.concurrency=8]
 * @returns {Promise<Array<{email,messageId,status,error}>>}  status: sent | failed | deferred
 */
async function sendBulkEmail({ fromEmail, fromName, replyTo, entries, concurrency = 8 }) {
  if (!isConfigured()) {
    return entries.map((e) => ({ email: e.email, messageId: null, status: "failed", error: "Brevo not configured" }));
  }
  const from = fromName ? { name: fromName, address: fromEmail } : fromEmail;
  const results = [];
  for (const group of chunk(entries, concurrency)) {
    const settled = await Promise.all(group.map(async (e) => {
      const unsub = unsubscribeUrl(e.unsubscribeToken);
      try {
        const info = await transporter().sendMail({
          from,
          to: e.email,
          replyTo: replyTo || undefined,
          subject: e.subject,
          html: e.html,
          headers: {
            "List-Unsubscribe": `<${unsub}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        });
        return { email: e.email, messageId: info.messageId || null, status: "sent", error: null };
      } catch (err) {
        const quota = isQuotaError(err);
        logger.warn("Brevo send failed", { email: e.email, error: err.message, quota });
        return { email: e.email, messageId: null, status: quota ? "deferred" : "failed", error: err.message };
      }
    }));
    results.push(...settled);
  }
  return results;
}

module.exports = { isConfigured, sendBulkEmail, _internal: { isQuotaError, chunk } };
