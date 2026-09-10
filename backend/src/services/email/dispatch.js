/**
 * Campaign dispatch: resolve recipients → batch → idempotent per-batch send.
 * Pure of queue wiring (workers.js owns the BullMQ queue) so it's unit-testable.
 */
const { query } = require("../../db/pool");
const logger = require("../../config/logger");
const provider = require("./provider");
const { renderHtmlForContact, applyMergeTags, contactFields } = require("./render");
const { buildAttachmentList } = require("./uploads");

// Messages/sec ceiling — also the batch size, so workers.js can cap at 1 batch/sec.
const SEND_RATE = Math.max(1, parseInt(process.env.SES_MAX_SEND_RATE, 10) || 10);

// Account-wide daily send budget. Brevo's free plan caps the WHOLE account at 300/day
// (marketing + transactional share it), so we default conservatively to 250 to leave
// headroom for transactional alerts. dripSend() never exceeds today's remaining budget.
const DAILY_CAP = Math.max(1, parseInt(process.env.EMAIL_DAILY_CAP, 10) || 250);

// How many transport-level failures one recipient gets before the row is given up on. Only
// transient deferrals count (see migration 051) — a relay hiccup should not cost a recipient,
// but an address that fails this way five days running is not going to start working.
const MAX_SEND_ATTEMPTS = Math.max(1, parseInt(process.env.EMAIL_MAX_SEND_ATTEMPTS, 10) || 5);

// Active, non-suppressed recipients for a campaign (segment filter is tags + status).
async function resolveRecipientIds(campaign) {
  const params = [campaign.workspace_id];
  let where = `c.workspace_id = $1 AND c.status = 'active'`;
  let seg = null;
  if (campaign.segment_id) {
    const { rows: [s] } = await query("SELECT filter FROM email_segments WHERE id=$1 AND workspace_id=$2",
      [campaign.segment_id, campaign.workspace_id]);
    seg = s?.filter || null;
  }
  if (seg && Array.isArray(seg.tags) && seg.tags.length) {
    params.push(seg.tags);
    where += ` AND c.tags && $${params.length}::text[]`;
  }
  // Exclude anyone on the workspace suppression list (case-insensitive).
  const { rows } = await query(
    `SELECT c.id FROM email_contacts c
       WHERE ${where}
         AND NOT EXISTS (
           SELECT 1 FROM email_suppressions s
            WHERE s.workspace_id = c.workspace_id AND lower(s.email) = lower(c.email))
       ORDER BY c.created_at`,
    params
  );
  return rows.map((r) => r.id);
}

/**
 * Prepare a campaign for sending: resolve recipients, create queued send rows
 * (idempotent), flip status to 'sending', and return contact-id batches.
 * @returns {Promise<{ total:number, batches:string[][] }>}
 */
async function prepareCampaign(campaignId) {
  const { rows: [campaign] } = await query("SELECT * FROM email_campaigns WHERE id=$1", [campaignId]);
  if (!campaign) throw new Error("Campaign not found");
  const ids = await resolveRecipientIds(campaign);
  if (ids.length) {
    // One queued send row per (campaign, contact); ON CONFLICT keeps reruns safe.
    await query(
      `INSERT INTO email_sends (campaign_id, contact_id, email, status)
         SELECT $1, c.id, c.email, 'queued' FROM email_contacts c
          WHERE c.id = ANY($2::uuid[])
       ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
      [campaignId, ids]
    );
  }
  await query(
    "UPDATE email_campaigns SET status='sending', recipients=$2, updated_at=NOW() WHERE id=$1",
    [campaignId, ids.length]
  );
  const batches = [];
  for (let i = 0; i < ids.length; i += SEND_RATE) batches.push(ids.slice(i, i + SEND_RATE));
  return { total: ids.length, batches };
}

/**
 * Send one batch. Idempotent: skips contacts whose send row is already past 'queued'
 * (so a BullMQ retry never re-sends a delivered/sent recipient). Updates send rows +
 * campaign counters, and marks the campaign 'sent' once no queued rows remain.
 */
async function processBatch({ campaignId, contactIds }) {
  const { rows: [campaign] } = await query("SELECT * FROM email_campaigns WHERE id=$1", [campaignId]);
  if (!campaign) { logger.warn("processBatch: campaign gone", { campaignId }); return { sent: 0, failed: 0 }; }

  // Only contacts still queued for THIS campaign (idempotency on retry).
  // s.id (the send row's own id) doubles as the per-recipient tracking tag passed to the
  // provider — see brevo.js's X-Mailin-Tag — so open/click/bounce webhook events can be
  // correlated straight back to this row without depending on the provider's own message id.
  const { rows: contacts } = await query(
    `SELECT c.*, s.id AS send_id FROM email_contacts c
       JOIN email_sends s ON s.contact_id = c.id AND s.campaign_id = $1
      WHERE c.id = ANY($2::uuid[]) AND s.status = 'queued'`,
    [campaignId, contactIds]
  );
  if (!contacts.length) { await maybeFinish(campaignId); return { sent: 0, failed: 0 }; }

  const entries = contacts.map((c) => ({
    email: c.email,
    subject: applyMergeTags(campaign.subject || "", contactFields(c)),
    html: renderHtmlForContact(campaign.html_body || "", c, { campaignId: campaign.id }),
    unsubscribeToken: c.unsubscribe_token,
    sendId: c.send_id,
    _contactId: c.id,
  }));

  if (campaign.attachments?.length && provider.name() === "ses") {
    logger.warn("SES provider does not support attachments; they will be silently dropped", { campaignId });
  }
  const results = await provider.sendBulkEmail({
    fromEmail: campaign.from_email || process.env.MAIL_FROM_EMAIL || process.env.SES_FROM_EMAIL,
    fromName:  campaign.from_name  || process.env.MAIL_FROM_NAME  || process.env.SES_FROM_NAME,
    replyTo:   campaign.reply_to   || process.env.MAIL_REPLY_TO   || process.env.SES_REPLY_TO,
    configurationSet: process.env.SES_CONFIGURATION_SET,
    entries,
    attachments: buildAttachmentList(campaign.attachments, campaignId),
  });

  const byEmail = new Map(results.map((r) => [r.email, r]));
  let sent = 0, failed = 0, deferred = 0, quotaHit = false;
  for (const c of contacts) {
    const r = byEmail.get(c.email) || { status: "failed", error: "no result" };
    // 'deferred' = worth trying again, for one of two reasons the provider tells apart:
    //   quota     — the ACCOUNT is out of budget today. Nothing about this recipient, costs
    //               no retry, and the caller stops the run: the next address would fail too.
    //   transient — the transport failed on this message (dropped connection, timeout, SMTP
    //               4yz). The row stays 'queued' for the next drip, but burns one attempt, so
    //               an address that fails this way every day is eventually given up on rather
    //               than retried forever.
    if (r.status === "deferred") {
      deferred++;
      // An adapter that defers without saying why means quota — that was what 'deferred' meant
      // before the two were told apart, and it is the reading that costs a recipient nothing.
      if ((r.deferReason || "quota") === "quota") { quotaHit = true; continue; }
      const { rows: [row] } = await query(
        `UPDATE email_sends SET attempts = attempts + 1, error = $3
           WHERE campaign_id = $1 AND contact_id = $2 RETURNING attempts`,
        [campaignId, c.id, r.error || "transient send failure"]);
      if ((row?.attempts || 0) >= MAX_SEND_ATTEMPTS) {
        // Out of retries: record it as a real failure so it leaves the queue and the campaign
        // can finish, and say so in the log rather than letting a recipient vanish quietly.
        await query(
          "UPDATE email_sends SET status = CASE WHEN status='queued' THEN 'failed' ELSE status END WHERE campaign_id=$1 AND contact_id=$2",
          [campaignId, c.id]);
        failed++;
        logger.warn("Giving up on a recipient after repeated transport failures",
          { campaignId, email: c.email, attempts: row?.attempts, error: r.error });
      }
      continue;
    }
    if (r.status === "sent") sent++; else failed++;
    // The provider's webhook can beat this write. Brevo accepts the message over SMTP,
    // delivers it, and posts `delivered` while this batch is still working through its other
    // concurrent sends — so by the time we get here the row may already say 'delivered' (or
    // 'bounced'). Overwriting it with 'sent' loses the verdict permanently: 507 of the 1990
    // rows of the 2026-07 campaign carry a delivered_at and a status of 'sent', which is why
    // its status breakdown shows 1070 delivered while its own counter says 1585.
    // Status only ever moves forward from 'queued' here; the message id and sent_at are still
    // recorded either way, since the id is what correlates late webhook events to this row.
    await query(
      `UPDATE email_sends
          SET status = CASE WHEN status = 'queued' THEN $3 ELSE status END,
              ses_message_id = $4,
              error = $5,
              sent_at = CASE WHEN $3 = 'sent' THEN COALESCE(sent_at, NOW()) ELSE sent_at END
        WHERE campaign_id=$1 AND contact_id=$2`,
      [campaignId, c.id, r.status, r.messageId || null, r.error || null]
    );
  }
  await query("UPDATE email_campaigns SET sent = sent + $2, updated_at=NOW() WHERE id=$1", [campaignId, sent]);
  await maybeFinish(campaignId);
  return { sent, failed, deferred, quotaHit };
}

// Mark the campaign 'sent' once nothing is left queued (safe with worker concurrency 1).
async function maybeFinish(campaignId) {
  const { rows: [{ n }] } = await query(
    "SELECT COUNT(*)::int AS n FROM email_sends WHERE campaign_id=$1 AND status='queued'", [campaignId]
  );
  if (n === 0) {
    await query(
      "UPDATE email_campaigns SET status='sent', sent_at=COALESCE(sent_at, NOW()), updated_at=NOW() WHERE id=$1 AND status='sending'",
      [campaignId]
    );
  }
}

// ── Daily-budget drip ─────────────────────────────────────────────────────────
// Emails already sent today (account-wide across all campaigns). Transactional alerts
// aren't tracked here, so DAILY_CAP is set below the provider's real cap to leave headroom.
async function sentToday() {
  const { rows: [{ n }] } = await query(
    `SELECT COUNT(*)::int AS n FROM email_sends
       WHERE sent_at >= date_trunc('day', now()) AND status <> 'queued'`);
  return n;
}

let _dripRunning = false;
// The day (YYYY-MM-DD) the provider last told us the account is out of quota. The drip runs
// every 5 minutes; without this it would keep reopening SMTP connections for the rest of the
// day — 288 futile passes — each one a rejected authentication attempt against Brevo. Cleared
// simply by the date changing.
let _quotaExhaustedOn = null;
const today = () => new Date().toISOString().slice(0, 10);
/**
 * Send as many queued recipients as today's budget allows, oldest campaign first, across
 * ALL 'sending' campaigns in the account. Idempotent and self-serialising (in-process lock)
 * so the 5-min cron and a manual send can't double-fire. Campaigns drain over several days
 * until the budget clears their queue; maybeFinish (inside processBatch) marks each 'sent'
 * once nothing is left queued for it.
 * @returns {Promise<{sent:number, budget:number, skipped?:boolean}>}
 */
async function dripSend() {
  if (_dripRunning) return { sent: 0, budget: 0, skipped: true };
  _dripRunning = true;
  try {
    if (!provider.isConfigured()) return { sent: 0, budget: 0, skipped: true };
    if (_quotaExhaustedOn === today()) return { sent: 0, budget: 0, skipped: true, quotaExhausted: true };
    const budget = DAILY_CAP - (await sentToday());
    if (budget <= 0) { logger.info("Email drip: daily budget exhausted", { cap: DAILY_CAP }); return { sent: 0, budget: 0 }; }

    // Pick up to `budget` queued recipients, FIFO by campaign then recipient.
    const { rows } = await query(
      `SELECT es.campaign_id, es.contact_id
         FROM email_sends es
         JOIN email_campaigns c ON c.id = es.campaign_id
        WHERE es.status = 'queued' AND c.status = 'sending'
        ORDER BY c.created_at, es.created_at
        LIMIT $1`,
      [budget]
    );
    if (!rows.length) return { sent: 0, budget };

    // Group by campaign; processBatch is idempotent per (campaign, contact).
    const byCampaign = new Map();
    for (const r of rows) {
      if (!byCampaign.has(r.campaign_id)) byCampaign.set(r.campaign_id, []);
      byCampaign.get(r.campaign_id).push(r.contact_id);
    }
    let sent = 0, quotaExhausted = false;
    for (const [campaignId, contactIds] of byCampaign) {
      const r = await processBatch({ campaignId, contactIds });
      sent += r.sent;
      // The provider says the account is done for today. Every remaining recipient would get
      // the same answer, so stop here instead of working through the rest of the budget.
      if (r.quotaHit) {
        quotaExhausted = true;
        _quotaExhaustedOn = today();
        logger.warn("Email drip stopped: provider reports the daily quota is exhausted",
          { sent, cap: DAILY_CAP, hint: "EMAIL_DAILY_CAP may be above the plan's real limit" });
        break;
      }
    }
    logger.info("Email drip sent", { sent, budget, cap: DAILY_CAP });
    return { sent, budget, ...(quotaExhausted ? { quotaExhausted: true } : {}) };
  } finally {
    _dripRunning = false;
  }
}

module.exports = { SEND_RATE, DAILY_CAP, MAX_SEND_ATTEMPTS, resolveRecipientIds, prepareCampaign, processBatch, maybeFinish, dripSend, sentToday };
