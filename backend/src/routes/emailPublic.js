/**
 * Marketing email — PUBLIC endpoints (no auth):
 *   GET/POST /email/unsubscribe/:token   — RFC 8058 one-click unsubscribe
 *   POST     /email/webhooks/ses         — SNS bounce/complaint/delivery events (legacy, SES-only)
 *   POST     /email/webhooks/brevo       — Brevo delivered/opened/click/bounce/spam events
 *
 * Mounted at /api/v1/email WITHOUT requireAuth/requireWorkspace.
 */
const express = require("express");
const https = require("https");
const router = express.Router();
const { query } = require("../db/pool");
const logger = require("../config/logger");
const { resolveUploadPath } = require("../services/email/uploads");

const MessageValidator = require("sns-validator");
const snsValidator = new MessageValidator();

// ── Uploaded campaign images / files (unauthenticated — mail clients have no session) ──
const CONTENT_TYPE_BY_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
  ".pdf": "application/pdf", ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function serveUpload(subdir) {
  return (req, res) => {
    const filePath = resolveUploadPath(subdir, req.params.id, req.params.filename);
    if (!filePath) return res.status(404).send("Not found");
    const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    res.set("Content-Type", CONTENT_TYPE_BY_EXT[ext] || "application/octet-stream");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(filePath);
  };
}

router.get("/uploads/images/:id/:filename", serveUpload("images"));
router.get("/uploads/files/:id/:filename", serveUpload("files"));

// ── Unsubscribe (RFC 8058) ───────────────────────────────────────────────────
// Resolve the opaque per-contact token → mark unsubscribed + add to suppression list.
// The token is per-contact (not per-send), so there's no direct link to "the campaign this
// unsubscribe came from" — best-effort attribute it to that contact's most recent send, same
// heuristic real ESPs use, so the campaign's own `unsubscribed` counter isn't permanently stuck
// at 0 (it previously wasn't touched here at all — every unsubscribe was invisible in stats).
async function doUnsubscribe(token) {
  const { rows: [c] } = await query(
    "SELECT id, workspace_id, email FROM email_contacts WHERE unsubscribe_token = $1", [token]);
  if (!c) return false;
  await query("UPDATE email_contacts SET status='unsubscribed', updated_at=NOW() WHERE id=$1", [c.id]);
  const { rows: [lastSend] } = await query(
    `SELECT campaign_id FROM email_sends WHERE contact_id=$1 AND status <> 'queued'
      ORDER BY sent_at DESC NULLS LAST, created_at DESC LIMIT 1`, [c.id]);
  await query(
    `INSERT INTO email_suppressions (workspace_id, email, reason, source_campaign_id) VALUES ($1,$2,'unsubscribe',$3)
     ON CONFLICT (workspace_id, lower(email)) DO NOTHING`, [c.workspace_id, c.email, lastSend?.campaign_id || null]);
  if (lastSend) await query("UPDATE email_campaigns SET unsubscribed = unsubscribed + 1 WHERE id=$1", [lastSend.campaign_id]);
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
    `SELECT es.id, es.campaign_id, es.contact_id, es.email, es.opened_at, es.clicked_at, c.workspace_id
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
    // Gate the aggregate counter on this being the FIRST open for this send — SES fires an
    // Open event per open, and re-opens are common (recipient reopens the email later); without
    // this guard `campaign.opened` counts total opens, not unique openers, and can end up
    // larger than `recipients` (was: unconditional +1 on every event, same bug the Brevo path
    // below is written to avoid from the start).
    if (sends[0] && !sends[0].opened_at) {
      await query("UPDATE email_sends SET opened_at=NOW() WHERE ses_message_id=$1", [messageId]);
      await query("UPDATE email_campaigns SET opened = opened + 1 WHERE id=$1", [sends[0].campaign_id]);
    }
  } else if (type === "Click") {
    if (sends[0] && !sends[0].clicked_at) {
      await query("UPDATE email_sends SET clicked_at=NOW() WHERE ses_message_id=$1", [messageId]);
      await query("UPDATE email_campaigns SET clicked = clicked + 1 WHERE id=$1", [sends[0].campaign_id]);
    }
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

// ── Brevo webhook ────────────────────────────────────────────────────────────
// Brevo recognizes X-Mailin-Tag even on plain SMTP-relayed mail (not just their REST API) and
// echoes it back verbatim as `tag` on every event for that message — see brevo.js's sendBulkEmail,
// which sets it to our own email_sends.id. That means correlation here needs no provider message-id
// matching at all, unlike the SES/SNS path above.
//
// Payload shape (per Brevo's transactional webhook docs — same fields for delivered/opened/click/
// bounce/spam/unsubscribed): { event, email, "message-id", tag, date, link?, reason? }. Brevo posts
// one event per request; defensively also accept an array in case that ever changes.
async function applyBrevoEvent(evt) {
  const type = String(evt?.event || "").toLowerCase();
  if (!type) return;

  let send = null;
  if (evt.tag) {
    const { rows } = await query(
      `SELECT es.id, es.campaign_id, es.contact_id, es.email, es.delivered_at, es.opened_at, es.clicked_at, c.workspace_id
         FROM email_sends es JOIN email_campaigns c ON c.id = es.campaign_id WHERE es.id = $1`,
      [evt.tag]);
    send = rows[0] || null;
  }
  // Fallback for sends made before the tag was wired up (matches nodemailer's own message-id,
  // which we store in ses_message_id regardless of provider).
  if (!send && evt["message-id"]) {
    const { rows } = await query(
      `SELECT es.id, es.campaign_id, es.contact_id, es.email, es.delivered_at, es.opened_at, es.clicked_at, c.workspace_id
         FROM email_sends es JOIN email_campaigns c ON c.id = es.campaign_id WHERE es.ses_message_id = $1
        ORDER BY es.created_at DESC LIMIT 1`,
      [evt["message-id"]]);
    send = rows[0] || null;
  }
  if (!send) return;

  const suppress = (reason) => query(
    `INSERT INTO email_suppressions (workspace_id, email, reason, source_campaign_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (workspace_id, lower(email)) DO NOTHING`,
    [send.workspace_id, send.email, reason, send.campaign_id]);

  if (type === "delivered") {
    if (!send.delivered_at) {
      await query("UPDATE email_sends SET status='delivered', delivered_at=NOW() WHERE id=$1 AND status NOT IN ('bounced','complained')", [send.id]);
      await query("UPDATE email_campaigns SET delivered = delivered + 1 WHERE id=$1", [send.campaign_id]);
    }
  } else if (type === "opened" || type === "unique_opened") {
    // Brevo's plain "opened" fires on every open (not just the first) unless the account is
    // specifically configured to only send "unique_opened" — gate on our own timestamp instead
    // of trusting which event name they send, so the aggregate counter reflects unique openers
    // (recipients who opened at least once) rather than total opens either way.
    if (!send.opened_at) {
      await query("UPDATE email_sends SET opened_at=NOW() WHERE id=$1", [send.id]);
      await query("UPDATE email_campaigns SET opened = opened + 1 WHERE id=$1", [send.campaign_id]);
    }
  } else if (type === "click" || type === "clicked") {
    if (!send.clicked_at) {
      await query("UPDATE email_sends SET clicked_at=NOW() WHERE id=$1", [send.id]);
      await query("UPDATE email_campaigns SET clicked = clicked + 1 WHERE id=$1", [send.campaign_id]);
    }
  } else if (type === "hard_bounce" || type === "blocked" || type === "invalid_email") {
    await query("UPDATE email_sends SET status='bounced', error=$2 WHERE id=$1", [send.id, evt.reason || type]);
    await query("UPDATE email_campaigns SET bounced = bounced + 1 WHERE id=$1", [send.campaign_id]);
    await suppress("hard_bounce");
    await query("UPDATE email_contacts SET status='bounced', updated_at=NOW() WHERE id=$1", [send.contact_id]);
  } else if (type === "soft_bounce") {
    // Transient — logged and counted, but NOT suppressed (unlike hard_bounce/blocked), since the
    // address may well accept mail on a future campaign (mirrors the SES permanent/transient split).
    await query("UPDATE email_sends SET status='bounced', error=$2 WHERE id=$1", [send.id, evt.reason || type]);
    await query("UPDATE email_campaigns SET bounced = bounced + 1 WHERE id=$1", [send.campaign_id]);
  } else if (type === "spam") {
    await query("UPDATE email_sends SET status='complained' WHERE id=$1", [send.id]);
    await query("UPDATE email_campaigns SET complained = complained + 1 WHERE id=$1", [send.campaign_id]);
    await suppress("complaint");
    await query("UPDATE email_contacts SET status='complained', updated_at=NOW() WHERE id=$1", [send.contact_id]);
  } else if (type === "unsubscribed") {
    // Unlikely to ever fire in practice — our emails carry our own RFC 8058 List-Unsubscribe
    // link (routes/emailPublic.js doUnsubscribe), not a Brevo-hosted one, so Brevo has no
    // unsubscribe click of its own to report. Handled anyway in case that ever changes.
    await query("UPDATE email_campaigns SET unsubscribed = unsubscribed + 1 WHERE id=$1", [send.campaign_id]);
    await suppress("unsubscribe");
    await query("UPDATE email_contacts SET status='unsubscribed', updated_at=NOW() WHERE id=$1", [send.contact_id]);
  }
  // request/deferred/error: transport-level states we already capture at send time; no action.
}

// Brevo doesn't sign webhook payloads, so authenticity is a shared secret baked into the URL
// itself (configured as the webhook target in Brevo's dashboard) — fail closed if it's not set
// rather than silently accepting unauthenticated writes to suppression/complaint status.
router.post("/webhooks/brevo", express.json({ limit: "256kb" }), async (req, res) => {
  const secret = process.env.BREVO_WEBHOOK_SECRET;
  if (!secret || req.query.token !== secret) return res.status(403).send("forbidden");
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    for (const evt of events) await applyBrevoEvent(evt);
    res.status(200).send("ok");
  } catch (e) {
    logger.error("Brevo webhook handling failed", { error: e.message });
    res.status(200).send("ok"); // 200 so Brevo doesn't retry-storm a transient DB error
  }
});

module.exports = router;
module.exports._internal = { doUnsubscribe, applySesEvent, applyBrevoEvent };
