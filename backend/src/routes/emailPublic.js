/**
 * Marketing email — PUBLIC endpoints (no auth):
 *   GET/POST /email/unsubscribe/:token   — RFC 8058 one-click unsubscribe
 *   POST     /email/webhooks/ses         — SNS bounce/complaint/delivery events
 *
 * Mounted at /api/v1/email WITHOUT requireAuth/requireWorkspace.
 */
const express = require("express");
const https = require("https");
const router = express.Router();
const { query } = require("../db/pool");
const logger = require("../config/logger");

const MessageValidator = require("sns-validator");
const snsValidator = new MessageValidator();

// ── Unsubscribe (RFC 8058) ───────────────────────────────────────────────────
// Resolve the opaque per-contact token → mark unsubscribed + add to suppression list.
async function doUnsubscribe(token) {
  const { rows: [c] } = await query(
    "SELECT id, workspace_id, email FROM email_contacts WHERE unsubscribe_token = $1", [token]);
  if (!c) return false;
  await query("UPDATE email_contacts SET status='unsubscribed', updated_at=NOW() WHERE id=$1", [c.id]);
  await query(
    `INSERT INTO email_suppressions (workspace_id, email, reason) VALUES ($1,$2,'unsubscribe')
     ON CONFLICT (workspace_id, lower(email)) DO NOTHING`, [c.workspace_id, c.email]);
  return true;
}

// One-click POST (mail clients post List-Unsubscribe=One-Click). Always 200 to avoid retries.
router.post("/unsubscribe/:token", express.urlencoded({ extended: false }), async (req, res) => {
  try { await doUnsubscribe(req.params.token); } catch (e) { logger.warn("unsubscribe POST failed", { error: e.message }); }
  res.status(200).send("Unsubscribed");
});

// Human click → friendly confirmation page (also performs the unsubscribe).
router.get("/unsubscribe/:token", async (req, res) => {
  let ok = false;
  try { ok = await doUnsubscribe(req.params.token); } catch (e) { logger.warn("unsubscribe GET failed", { error: e.message }); }
  res.set("Content-Type", "text/html; charset=utf-8").send(`<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Unsubscribe</title></head>
    <body style="font-family:-apple-system,Segoe UI,sans-serif;background:#0f1117;color:#e2e8f0;text-align:center;padding:60px 20px;">
      <h1 style="font-size:22px;">${ok ? "You're unsubscribed" : "Link expired or invalid"}</h1>
      <p style="color:#94a3b8;">${ok ? "You won't receive further marketing emails." : "This unsubscribe link is no longer valid."}</p>
    </body></html>`);
});

// ── SES → SNS webhook ─────────────────────────────────────────────────────────
function confirmSubscription(subscribeUrl) {
  return new Promise((resolve) => {
    https.get(subscribeUrl, (r) => { r.resume(); resolve(true); }).on("error", (e) => {
      logger.warn("SNS subscribe confirm failed", { error: e.message }); resolve(false);
    });
  });
}

// Apply one SES event (bounce/complaint/delivery/open/click) to the send log + suppression.
async function applySesEvent(evt) {
  const type = evt.eventType || evt.notificationType; // event-publishing vs legacy notification
  const messageId = evt.mail?.messageId;
  if (!type || !messageId) return;

  // Find the send row(s) for this SES messageId to learn workspace/campaign.
  const { rows: sends } = await query(
    `SELECT es.id, es.campaign_id, es.contact_id, es.email, c.workspace_id
       FROM email_sends es JOIN email_campaigns c ON c.id = es.campaign_id
      WHERE es.ses_message_id = $1`, [messageId]);

  const suppress = async (email, workspaceId, reason, campaignId) => {
    await query(`INSERT INTO email_suppressions (workspace_id, email, reason, source_campaign_id)
                 VALUES ($1,$2,$3,$4) ON CONFLICT (workspace_id, lower(email)) DO NOTHING`,
      [workspaceId, email, reason, campaignId || null]);
  };

  if (type === "Bounce") {
    const permanent = (evt.bounce?.bounceType || "").toLowerCase() === "permanent";
    for (const r of (evt.bounce?.bouncedRecipients || [])) {
      await query("UPDATE email_sends SET status='bounced' WHERE ses_message_id=$1 AND lower(email)=lower($2)", [messageId, r.emailAddress]);
      const s = sends.find((x) => x.email.toLowerCase() === String(r.emailAddress).toLowerCase()) || sends[0];
      if (s) {
        await query("UPDATE email_campaigns SET bounced = bounced + 1 WHERE id=$1", [s.campaign_id]);
        if (permanent) {
          await suppress(r.emailAddress, s.workspace_id, "hard_bounce", s.campaign_id);
          await query("UPDATE email_contacts SET status='bounced', updated_at=NOW() WHERE id=$1", [s.contact_id]);
        }
      }
    }
  } else if (type === "Complaint") {
    for (const r of (evt.complaint?.complainedRecipients || [])) {
      await query("UPDATE email_sends SET status='complained' WHERE ses_message_id=$1 AND lower(email)=lower($2)", [messageId, r.emailAddress]);
      const s = sends.find((x) => x.email.toLowerCase() === String(r.emailAddress).toLowerCase()) || sends[0];
      if (s) {
        await query("UPDATE email_campaigns SET complained = complained + 1 WHERE id=$1", [s.campaign_id]);
        await suppress(r.emailAddress, s.workspace_id, "complaint", s.campaign_id);
        await query("UPDATE email_contacts SET status='complained', updated_at=NOW() WHERE id=$1", [s.contact_id]);
      }
    }
  } else if (type === "Delivery") {
    await query("UPDATE email_sends SET status='delivered', delivered_at=NOW() WHERE ses_message_id=$1 AND status NOT IN ('bounced','complained')", [messageId]);
    if (sends[0]) await query("UPDATE email_campaigns SET delivered = delivered + 1 WHERE id=$1", [sends[0].campaign_id]);
  } else if (type === "Open") {
    await query("UPDATE email_sends SET opened_at = COALESCE(opened_at, NOW()) WHERE ses_message_id=$1", [messageId]);
    if (sends[0]) await query("UPDATE email_campaigns SET opened = opened + 1 WHERE id=$1", [sends[0].campaign_id]);
  } else if (type === "Click") {
    await query("UPDATE email_sends SET clicked_at = COALESCE(clicked_at, NOW()) WHERE ses_message_id=$1", [messageId]);
    if (sends[0]) await query("UPDATE email_campaigns SET clicked = clicked + 1 WHERE id=$1", [sends[0].campaign_id]);
  }
}

// SNS posts text/plain JSON; read it raw then validate the signature before trusting it.
router.post("/webhooks/ses", express.text({ type: "*/*", limit: "1mb" }), async (req, res) => {
  let msg;
  try { msg = typeof req.body === "string" ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).send("bad json"); }

  snsValidator.validate(msg, async (err, message) => {
    if (err) { logger.warn("SNS signature validation failed", { error: err.message }); return res.status(403).send("invalid signature"); }
    try {
      if (message.Type === "SubscriptionConfirmation") {
        await confirmSubscription(message.SubscribeURL);
        return res.status(200).send("confirmed");
      }
      if (message.Type === "Notification") {
        const evt = JSON.parse(message.Message);
        await applySesEvent(evt);
        return res.status(200).send("ok");
      }
      return res.status(200).send("ignored");
    } catch (e) {
      logger.error("SES webhook handling failed", { error: e.message });
      return res.status(200).send("ok"); // 200 so SNS doesn't retry-storm a transient DB error
    }
  });
});

module.exports = router;
module.exports._internal = { doUnsubscribe, applySesEvent };
