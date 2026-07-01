/**
 * Campaign dispatch: resolve recipients → batch → idempotent per-batch send.
 * Pure of queue wiring (workers.js owns the BullMQ queue) so it's unit-testable.
 */
const { query } = require("../../db/pool");
const logger = require("../../config/logger");
const provider = require("./provider");
const { renderHtmlForContact, applyMergeTags, contactFields } = require("./render");

// Messages/sec ceiling — also the batch size, so workers.js can cap at 1 batch/sec.
const SEND_RATE = Math.max(1, parseInt(process.env.SES_MAX_SEND_RATE, 10) || 10);

// Account-wide daily send budget. Brevo's free plan caps the WHOLE account at 300/day
// (marketing + transactional share it), so we default conservatively to 250 to leave
// headroom for transactional alerts. dripSend() never exceeds today's remaining budget.
const DAILY_CAP = Math.max(1, parseInt(process.env.EMAIL_DAILY_CAP, 10) || 250);

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
  const { rows: contacts } = await query(
    `SELECT c.* FROM email_contacts c
       JOIN email_sends s ON s.contact_id = c.id AND s.campaign_id = $1
      WHERE c.id = ANY($2::uuid[]) AND s.status = 'queued'`,
    [campaignId, contactIds]
  );
  if (!contacts.length) { await maybeFinish(campaignId); return { sent: 0, failed: 0 }; }

  const entries = contacts.map((c) => ({
    email: c.email,
    subject: applyMergeTags(campaign.subject || "", contactFields(c)),
    html: renderHtmlForContact(campaign.html_body || "", c),
    unsubscribeToken: c.unsubscribe_token,
    _contactId: c.id,
  }));

  const results = await provider.sendBulkEmail({
    fromEmail: campaign.from_email || process.env.MAIL_FROM_EMAIL || process.env.SES_FROM_EMAIL,
    fromName:  campaign.from_name  || process.env.MAIL_FROM_NAME  || process.env.SES_FROM_NAME,
    replyTo:   campaign.reply_to   || process.env.MAIL_REPLY_TO   || process.env.SES_REPLY_TO,
    configurationSet: process.env.SES_CONFIGURATION_SET,
    entries,
  });

  const byEmail = new Map(results.map((r) => [r.email, r]));
  let sent = 0, failed = 0;
  for (const c of contacts) {
    const r = byEmail.get(c.email) || { status: "failed", error: "no result" };
    // 'deferred' = provider hit the daily quota → leave the row 'queued' so the next
    // drip day retries it, rather than burning the recipient as a permanent failure.
    if (r.status === "deferred") continue;
    if (r.status === "sent") sent++; else failed++;
    await query(
      `UPDATE email_sends SET status=$3, ses_message_id=$4, error=$5,
              sent_at = CASE WHEN $3='sent' THEN NOW() ELSE sent_at END
        WHERE campaign_id=$1 AND contact_id=$2`,
      [campaignId, c.id, r.status, r.messageId || null, r.error || null]
    );
  }
  await query("UPDATE email_campaigns SET sent = sent + $2, updated_at=NOW() WHERE id=$1", [campaignId, sent]);
  await maybeFinish(campaignId);
  return { sent, failed };
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
    let sent = 0;
    for (const [campaignId, contactIds] of byCampaign) {
      const r = await processBatch({ campaignId, contactIds });
      sent += r.sent;
    }
    logger.info("Email drip sent", { sent, budget, cap: DAILY_CAP });
    return { sent, budget };
  } finally {
    _dripRunning = false;
  }
}

module.exports = { SEND_RATE, DAILY_CAP, resolveRecipientIds, prepareCampaign, processBatch, maybeFinish, dripSend, sentToday };
