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
const { renderHtmlForContact, esc } = require("../services/email/render");

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
  // The counter follows the contact actually changing state, not the link being hit. The same
  // link gets opened more than once in practice — a second click, a mail client that prefetches
  // it, a browser reload of the confirmation page — and counting each hit would report more
  // unsubscribes for a campaign than it had recipients. Unsubscribing stays idempotent either
  // way: status and suppression are both already set the second time round.
  const { rowCount: changed } = await query(
    "UPDATE email_contacts SET status='unsubscribed', updated_at=NOW() WHERE id=$1 AND status <> 'unsubscribed'", [c.id]);
  const { rows: [lastSend] } = await query(
    `SELECT campaign_id FROM email_sends WHERE contact_id=$1 AND status <> 'queued'
      ORDER BY sent_at DESC NULLS LAST, created_at DESC LIMIT 1`, [c.id]);
  await query(
    `INSERT INTO email_suppressions (workspace_id, email, reason, source_campaign_id) VALUES ($1,$2,'unsubscribe',$3)
     ON CONFLICT (workspace_id, lower(email)) DO NOTHING`, [c.workspace_id, c.email, lastSend?.campaign_id || null]);
  if (lastSend && changed) await query("UPDATE email_campaigns SET unsubscribed = unsubscribed + 1 WHERE id=$1", [lastSend.campaign_id]);
  return true;
}

// "View in browser" for a campaign the recipient was actually sent.
//
// Templates in this project carry a `{{ mirror }}` link, but it was never a merge tag — it
// resolved to the empty string and shipped as `href=""` (the one campaign sent so far reached
// 1070 recipients that way), and there was no route behind it either. Both halves are fixed
// together: the tag now renders, and this serves it.
//
// Keyed by the recipient's own opaque unsubscribe token as well as the campaign id, so the URL
// is not enumerable and only someone who received the email can open it. The page is rendered
// for that recipient, exactly as their copy was — merge tags and compliance footer included.
router.get("/campaigns/:id/mirror/:token", async (req, res) => {
  try {
    const { rows: [contact] } = await query(
      "SELECT * FROM email_contacts WHERE unsubscribe_token = $1", [req.params.token]);
    if (!contact) return res.status(404).send("Link expired or invalid");

    // The campaign has to belong to the same workspace as the token holder, and has to have
    // actually been sent — a draft is not something a recipient can have received.
    const { rows: [campaign] } = await query(
      `SELECT id, html_body, subject FROM email_campaigns
        WHERE id = $1 AND workspace_id = $2 AND status IN ('sending','sent','paused')`,
      [req.params.id, contact.workspace_id]);
    if (!campaign) return res.status(404).send("Link expired or invalid");

    res.set("Content-Type", "text/html; charset=utf-8")
       .send(renderHtmlForContact(campaign.html_body || "", contact, { campaignId: campaign.id }));
  } catch (e) {
    logger.warn("campaign mirror failed", { error: e.message });
    res.status(500).send("Could not load this email");
  }
});

// Everything a recipient sees on this route, in the language the mail was written in. The page
// is served from the API, not the app, so it cannot reach the frontend's i18n bundle.
const UNSUB_TEXT = {
  en: { confirmTitle: "Unsubscribe", confirmBody: "Confirm that you no longer want to receive marketing email at this address.",
        confirmBtn: "Unsubscribe", doneTitle: "You're unsubscribed", doneBody: "You won't receive further marketing emails.",
        badTitle: "Link expired or invalid", badBody: "This unsubscribe link is no longer valid." },
  de: { confirmTitle: "Abmelden", confirmBody: "Bestätigen Sie, dass Sie an dieser Adresse keine Werbe-E-Mails mehr erhalten möchten.",
        confirmBtn: "Abmelden", doneTitle: "Sie sind abgemeldet", doneBody: "Sie erhalten keine weiteren Werbe-E-Mails.",
        badTitle: "Link abgelaufen oder ungültig", badBody: "Dieser Abmeldelink ist nicht mehr gültig." },
  ru: { confirmTitle: "Отписка", confirmBody: "Подтвердите, что вы больше не хотите получать рекламные письма на этот адрес.",
        confirmBtn: "Отписаться", doneTitle: "Вы отписаны", doneBody: "Рекламные письма больше приходить не будут.",
        badTitle: "Ссылка недействительна", badBody: "Этот адрес отписки больше не действует." },
};
const unsubText = (req) => {
  const want = String(req.query.lang || process.env.MAIL_DEFAULT_LOCALE || "en").slice(0, 2).toLowerCase();
  return UNSUB_TEXT[want] || UNSUB_TEXT.en;
};

const unsubPage = (title, body, extra = "") => `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="robots" content="noindex">
    <title>${esc(title)}</title></head>
    <body style="font-family:-apple-system,Segoe UI,sans-serif;background:#0f1117;color:#e2e8f0;text-align:center;padding:60px 20px;">
      <h1 style="font-size:22px;">${esc(title)}</h1>
      <p style="color:#94a3b8;">${esc(body)}</p>
      ${extra}
    </body></html>`;

// One-click POST — this is the one that actually unsubscribes.
//
// Mail clients post here for RFC 8058 List-Unsubscribe-Post (Gmail's own "Unsubscribe" button),
// and the confirmation page below posts here too. Always 200, so a client does not retry.
router.post("/unsubscribe/:token", express.urlencoded({ extended: false }), async (req, res) => {
  let ok = false;
  try { ok = await doUnsubscribe(req.params.token); } catch (e) { logger.warn("unsubscribe POST failed", { error: e.message }); }
  // A form submission wants a page back; a mail client's one-click post does not care.
  if (String(req.get("accept") || "").includes("text/html")) {
    const t = unsubText(req);
    return res.set("Content-Type", "text/html; charset=utf-8")
      .send(ok ? unsubPage(t.doneTitle, t.doneBody) : unsubPage(t.badTitle, t.badBody));
  }
  res.status(200).send("Unsubscribed");
});

// GET shows a confirmation page and changes nothing.
//
// It used to unsubscribe on sight, which is defensible for a human clicking a link — a click is
// a GET — but this address list is 3,102 business mailboxes, and corporate mail gateways
// (Outlook Safe Links, Proofpoint, Mimecast) fetch every URL in a message before the recipient
// ever sees it. Those recipients would have been unsubscribed by a scanner, silently, with no
// way to tell that from a real opt-out. This was not theory: an internal check script fetched a
// live token "to see that it returned 200" and unsubscribed a real contact.
//
// The legally required one-click path is untouched — it is the POST above, which is what the
// List-Unsubscribe-Post header points at and what a mail client's own button uses.
router.get("/unsubscribe/:token", async (req, res) => {
  const t = unsubText(req);
  // Whether the token resolves is safe to reveal — it is already in the recipient's own mail —
  // and telling them up front beats a button that turns out to do nothing.
  let known = false;
  try {
    const { rows } = await query("SELECT 1 FROM email_contacts WHERE unsubscribe_token = $1", [req.params.token]);
    known = rows.length > 0;
  } catch (e) { logger.warn("unsubscribe GET lookup failed", { error: e.message }); }

  if (!known) {
    return res.set("Content-Type", "text/html; charset=utf-8").send(unsubPage(t.badTitle, t.badBody));
  }
  const action = `/api/v1/email/unsubscribe/${encodeURIComponent(req.params.token)}`;
  const form = `<form method="post" action="${esc(action)}" style="margin-top:22px;">
        <button type="submit" style="font-family:inherit;font-size:15px;font-weight:600;padding:12px 28px;
          border:0;border-radius:6px;background:#2f6fa8;color:#fff;cursor:pointer;">${esc(t.confirmBtn)}</button>
      </form>`;
  res.set("Content-Type", "text/html; charset=utf-8").send(unsubPage(t.confirmTitle, t.confirmBody, form));
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
// A single X-Mailin-Tag SMTP header comes back from Brevo's webhook as a JSON-stringified
// one-element array (e.g. '["<uuid>"]') rather than the bare value — presumably because Brevo
// models tags as a list internally regardless of transport. Passing that string straight into
// a `uuid = $1` query 400s in Postgres ("invalid input syntax for type uuid"), silently dropping
// every delivered/opened/click event. Unwrap it defensively; a plain tag passes through as-is.
function normalizeTag(tag) {
  if (tag == null) return null;
  const s = String(tag);
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr[0] != null ? String(arr[0]) : null;
    } catch { /* not actually JSON — fall through and use the raw string */ }
  }
  return s;
}

async function applyBrevoEvent(evt) {
  const type = String(evt?.event || "").toLowerCase();
  if (!type) return;

  let send = null;
  const tag = normalizeTag(evt.tag);
  if (tag) {
    const { rows } = await query(
      `SELECT es.id, es.campaign_id, es.contact_id, es.email, es.delivered_at, es.opened_at, es.clicked_at, c.workspace_id
         FROM email_sends es JOIN email_campaigns c ON c.id = es.campaign_id WHERE es.id = $1`,
      [tag]);
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

  // Every aggregate counter below is incremented only when the send row it describes
  // actually changed. Providers repeat events — a retry, a soft_bounce followed by a
  // blocked, a second delivery attempt — and a counter that adds one per *event* rather
  // than per *row transition* drifts away from the rows it is supposed to summarise. The
  // 2026-07 campaign shows exactly that: `bounced` = 168 against 125 rows actually bounced,
  // `delivered` = 1585 against 1583 rows with a delivered_at.
  if (type === "delivered") {
    if (!send.delivered_at) {
      const { rowCount } = await query(
        "UPDATE email_sends SET status='delivered', delivered_at=NOW() WHERE id=$1 AND delivered_at IS NULL AND status NOT IN ('bounced','complained')",
        [send.id]);
      if (rowCount) await query("UPDATE email_campaigns SET delivered = delivered + 1 WHERE id=$1", [send.campaign_id]);
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
    const { rowCount } = await query(
      "UPDATE email_sends SET status='bounced', error=$2 WHERE id=$1 AND status <> 'bounced'", [send.id, evt.reason || type]);
    if (rowCount) await query("UPDATE email_campaigns SET bounced = bounced + 1 WHERE id=$1", [send.campaign_id]);
    // Suppression and contact status are idempotent in themselves, and must run even for a
    // repeat event: the point is that this address stays excluded, not that we counted it.
    await suppress("hard_bounce");
    await query("UPDATE email_contacts SET status='bounced', updated_at=NOW() WHERE id=$1", [send.contact_id]);
  } else if (type === "soft_bounce") {
    // Transient — logged and counted, but NOT suppressed (unlike hard_bounce/blocked), since the
    // address may well accept mail on a future campaign (mirrors the SES permanent/transient split).
    const { rowCount } = await query(
      "UPDATE email_sends SET status='bounced', error=$2 WHERE id=$1 AND status <> 'bounced'", [send.id, evt.reason || type]);
    if (rowCount) await query("UPDATE email_campaigns SET bounced = bounced + 1 WHERE id=$1", [send.campaign_id]);
  } else if (type === "spam") {
    const { rowCount } = await query(
      "UPDATE email_sends SET status='complained' WHERE id=$1 AND status <> 'complained'", [send.id]);
    if (rowCount) await query("UPDATE email_campaigns SET complained = complained + 1 WHERE id=$1", [send.campaign_id]);
    await suppress("complaint");
    await query("UPDATE email_contacts SET status='complained', updated_at=NOW() WHERE id=$1", [send.contact_id]);
  } else if (type === "unsubscribed") {
    // Unlikely to ever fire in practice — our emails carry our own RFC 8058 List-Unsubscribe
    // link (routes/emailPublic.js doUnsubscribe), not a Brevo-hosted one, so Brevo has no
    // unsubscribe click of its own to report. Handled anyway in case that ever changes.
    const { rowCount } = await query(
      "UPDATE email_contacts SET status='unsubscribed', updated_at=NOW() WHERE id=$1 AND status <> 'unsubscribed'",
      [send.contact_id]);
    if (rowCount) await query("UPDATE email_campaigns SET unsubscribed = unsubscribed + 1 WHERE id=$1", [send.campaign_id]);
    await suppress("unsubscribe");
  }
  // request/deferred/error: transport-level states we already capture at send time; no action.
}

// Brevo doesn't sign webhook payloads, so authenticity is a shared secret baked into the URL
// itself (configured as the webhook target in Brevo's dashboard) — fail closed if it's not set
// rather than silently accepting unauthenticated writes to suppression/complaint status.
let _rejectedWebhookLoggedAt = 0;
router.post("/webhooks/brevo", express.json({ limit: "256kb" }), async (req, res) => {
  const secret = process.env.BREVO_WEBHOOK_SECRET;
  if (!secret || req.query.token !== secret) {
    // Failing closed is right; failing closed in silence is how this goes unnoticed for weeks.
    // With BREVO_WEBHOOK_SECRET unset the endpoint rejects every event the provider sends, so
    // delivered/opened/bounced stats stop moving and hard bounces stop being suppressed — with
    // nothing in the log to say why. Rate-limited to one line an hour so a misconfigured or
    // hostile caller cannot flood the log either.
    const now = Date.now();
    if (now - _rejectedWebhookLoggedAt > 3600_000) {
      _rejectedWebhookLoggedAt = now;
      logger.warn("Brevo webhook rejected — events are being dropped", {
        reason: secret ? "token mismatch" : "BREVO_WEBHOOK_SECRET is not set",
        hint: "set BREVO_WEBHOOK_SECRET and point Brevo's webhook URL at ?token=<that value>",
      });
    }
    return res.status(403).send("forbidden");
  }
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
