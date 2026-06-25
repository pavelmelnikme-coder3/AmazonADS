/**
 * Campaign dispatch: resolve recipients → batch → idempotent per-batch send.
 * Pure of queue wiring (workers.js owns the BullMQ queue) so it's unit-testable.
 */
const { query } = require("../../db/pool");
const logger = require("../../config/logger");
const ses = require("./ses");
const { renderHtmlForContact, applyMergeTags, contactFields } = require("./render");

// Messages/sec ceiling — also the batch size, so workers.js can cap at 1 batch/sec.
const SEND_RATE = Math.max(1, parseInt(process.env.SES_MAX_SEND_RATE, 10) || 10);

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

  const results = await ses.sendBulkEmail({
    fromEmail: campaign.from_email || process.env.SES_FROM_EMAIL,
    fromName:  campaign.from_name  || process.env.SES_FROM_NAME,
    replyTo:   campaign.reply_to   || process.env.SES_REPLY_TO,
    configurationSet: process.env.SES_CONFIGURATION_SET,
    entries,
  });

  const byEmail = new Map(results.map((r) => [r.email, r]));
  let sent = 0, failed = 0;
  for (const c of contacts) {
    const r = byEmail.get(c.email) || { status: "failed", error: "no result" };
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

module.exports = { SEND_RATE, resolveRecipientIds, prepareCampaign, processBatch, maybeFinish };
