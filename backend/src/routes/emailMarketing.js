/**
 * Marketing email — authenticated API (workspace-scoped).
 *   Contacts:     GET/POST(import)/PATCH/DELETE  /contacts
 *   Segments:     CRUD                            /segments
 *   Campaigns:    CRUD + test/send/schedule/pause/stats
 *   Suppressions: GET/POST/DELETE                 /suppressions
 *
 * Sends go through the SES queue (queueEmailCampaign); nothing is sent synchronously here.
 */
const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const logger = require("../config/logger");
const { writeAudit } = require("./audit");
const { isConfigured, sendBulkEmail } = require("../services/email/provider");
const { renderHtmlForContact, applyMergeTags, contactFields } = require("../services/email/render");

router.use(requireAuth, requireWorkspace);

const newToken = () => crypto.randomBytes(24).toString("hex");
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());

// ─── Contacts ─────────────────────────────────────────────────────────────────
router.get("/contacts", async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const offset = (page - 1) * limit;
    const params = [req.workspaceId];
    let where = "workspace_id = $1";
    if (req.query.status) { params.push(req.query.status); where += ` AND status = $${params.length}`; }
    if (req.query.tag) { params.push([req.query.tag]); where += ` AND tags && $${params.length}::text[]`; }
    if (req.query.search) { params.push(`%${req.query.search.toLowerCase()}%`); where += ` AND lower(email) LIKE $${params.length}`; }
    const [{ rows }, { rows: [{ total }] }] = await Promise.all([
      query(`SELECT id, email, first_name, last_name, attributes, tags, status, consent_source, consent_at, created_at
              FROM email_contacts WHERE ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
      query(`SELECT COUNT(*)::int AS total FROM email_contacts WHERE ${where}`, params),
    ]);
    res.json({ data: rows, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
});

// Import already-consented contacts. consent fields are required (GDPR proof).
router.post("/contacts/import", async (req, res, next) => {
  try {
    const { contacts, consent_source, consent_method = "import" } = req.body;
    if (!Array.isArray(contacts) || !contacts.length) return res.status(400).json({ error: "contacts[] required" });
    if (!consent_source) return res.status(400).json({ error: "consent_source required (GDPR proof of opt-in)" });

    let imported = 0, skipped = 0, invalid = 0;
    for (const c of contacts) {
      const email = String(c.email || "").trim().toLowerCase();
      if (!isEmail(email)) { invalid++; continue; }
      const { rowCount } = await query(
        `INSERT INTO email_contacts
           (workspace_id, email, first_name, last_name, attributes, tags, status,
            consent_source, consent_method, consent_at, consent_ip, unsubscribe_token)
         VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,NOW(),$9,$10)
         ON CONFLICT (workspace_id, lower(email)) DO NOTHING`,
        [req.workspaceId, email, c.first_name || null, c.last_name || null,
         JSON.stringify(c.attributes || {}), Array.isArray(c.tags) ? c.tags : [],
         consent_source, consent_method, c.consent_ip || req.ip || null, newToken()]
      );
      if (rowCount) imported++; else skipped++;
    }
    res.json({ imported, skipped, invalid });
  } catch (err) { next(err); }
});

router.patch("/contacts/:id", async (req, res, next) => {
  try {
    const { first_name, last_name, attributes, tags, status } = req.body;
    const { rows: [c] } = await query(
      `UPDATE email_contacts SET
         first_name = COALESCE($3, first_name),
         last_name  = COALESCE($4, last_name),
         attributes = COALESCE($5, attributes),
         tags       = COALESCE($6, tags),
         status     = COALESCE($7, status),
         updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2 RETURNING *`,
      [req.params.id, req.workspaceId, first_name ?? null, last_name ?? null,
       attributes ? JSON.stringify(attributes) : null, Array.isArray(tags) ? tags : null, status ?? null]
    );
    if (!c) return res.status(404).json({ error: "Contact not found" });
    res.json(c);
  } catch (err) { next(err); }
});

router.delete("/contacts/:id", async (req, res, next) => {
  try {
    const { rowCount } = await query("DELETE FROM email_contacts WHERE id=$1 AND workspace_id=$2",
      [req.params.id, req.workspaceId]);
    if (!rowCount) return res.status(404).json({ error: "Contact not found" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Segments ─────────────────────────────────────────────────────────────────
router.get("/segments", async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM email_segments WHERE workspace_id=$1 ORDER BY created_at DESC", [req.workspaceId]);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.post("/segments", async (req, res, next) => {
  try {
    const { name, filter = {} } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const { rows: [s] } = await query(
      "INSERT INTO email_segments (workspace_id, name, filter) VALUES ($1,$2,$3) RETURNING *",
      [req.workspaceId, name, JSON.stringify(filter)]
    );
    res.status(201).json(s);
  } catch (err) { next(err); }
});

router.put("/segments/:id", async (req, res, next) => {
  try {
    const { name, filter } = req.body;
    const { rows: [s] } = await query(
      "UPDATE email_segments SET name=COALESCE($3,name), filter=COALESCE($4,filter), updated_at=NOW() WHERE id=$1 AND workspace_id=$2 RETURNING *",
      [req.params.id, req.workspaceId, name ?? null, filter ? JSON.stringify(filter) : null]
    );
    if (!s) return res.status(404).json({ error: "Segment not found" });
    res.json(s);
  } catch (err) { next(err); }
});

router.delete("/segments/:id", async (req, res, next) => {
  try {
    await query("DELETE FROM email_segments WHERE id=$1 AND workspace_id=$2", [req.params.id, req.workspaceId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Campaigns ────────────────────────────────────────────────────────────────
router.get("/campaigns", async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM email_campaigns WHERE workspace_id=$1 ORDER BY created_at DESC", [req.workspaceId]);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.get("/campaigns/:id", async (req, res, next) => {
  try {
    const { rows: [c] } = await query("SELECT * FROM email_campaigns WHERE id=$1 AND workspace_id=$2", [req.params.id, req.workspaceId]);
    if (!c) return res.status(404).json({ error: "Campaign not found" });
    res.json(c);
  } catch (err) { next(err); }
});

router.post("/campaigns", async (req, res, next) => {
  try {
    const { name, subject = "", from_name, from_email, reply_to, html_body = "", segment_id = null } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const { rows: [c] } = await query(
      `INSERT INTO email_campaigns (workspace_id, name, subject, from_name, from_email, reply_to, html_body, segment_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.workspaceId, name, subject, from_name || null, from_email || null, reply_to || null, html_body, segment_id, req.user.id]
    );
    res.status(201).json(c);
  } catch (err) { next(err); }
});

router.put("/campaigns/:id", async (req, res, next) => {
  try {
    const { name, subject, from_name, from_email, reply_to, html_body, segment_id } = req.body;
    // Only editable while not in-flight.
    const { rows: [c] } = await query(
      `UPDATE email_campaigns SET
         name=COALESCE($3,name), subject=COALESCE($4,subject), from_name=COALESCE($5,from_name),
         from_email=COALESCE($6,from_email), reply_to=COALESCE($7,reply_to), html_body=COALESCE($8,html_body),
         segment_id=$9, updated_at=NOW()
       WHERE id=$1 AND workspace_id=$2 AND status IN ('draft','scheduled','paused') RETURNING *`,
      [req.params.id, req.workspaceId, name ?? null, subject ?? null, from_name ?? null,
       from_email ?? null, reply_to ?? null, html_body ?? null, segment_id ?? null]
    );
    if (!c) return res.status(409).json({ error: "Campaign not found or not editable" });
    res.json(c);
  } catch (err) { next(err); }
});

router.delete("/campaigns/:id", async (req, res, next) => {
  try {
    const { rowCount } = await query("DELETE FROM email_campaigns WHERE id=$1 AND workspace_id=$2 AND status IN ('draft','scheduled','paused','failed')",
      [req.params.id, req.workspaceId]);
    if (!rowCount) return res.status(409).json({ error: "Campaign not found or not deletable" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Send a one-off test to a single address (no contact row needed; uses a throwaway token).
router.post("/campaigns/:id/test", async (req, res, next) => {
  try {
    if (!isConfigured()) return res.status(400).json({ error: "Email sender not configured" });
    const { email } = req.body;
    if (!isEmail(email)) return res.status(400).json({ error: "valid email required" });
    const { rows: [c] } = await query("SELECT * FROM email_campaigns WHERE id=$1 AND workspace_id=$2", [req.params.id, req.workspaceId]);
    if (!c) return res.status(404).json({ error: "Campaign not found" });
    const fakeContact = { email, first_name: "", last_name: "", attributes: {}, unsubscribe_token: "test-" + newToken() };
    const [r] = await sendBulkEmail({
      fromEmail: c.from_email || process.env.MAIL_FROM_EMAIL || process.env.SES_FROM_EMAIL,
      fromName:  c.from_name  || process.env.MAIL_FROM_NAME  || process.env.SES_FROM_NAME,
      replyTo:   c.reply_to   || process.env.MAIL_REPLY_TO   || process.env.SES_REPLY_TO,
      configurationSet: process.env.SES_CONFIGURATION_SET,
      entries: [{ email, subject: `[TEST] ${applyMergeTags(c.subject || "", contactFields(fakeContact))}`,
                  html: renderHtmlForContact(c.html_body || "", fakeContact), unsubscribeToken: fakeContact.unsubscribe_token }],
    });
    if (r.status !== "sent") return res.status(502).json({ error: r.error || "send failed" });
    res.json({ ok: true, messageId: r.messageId });
  } catch (err) { next(err); }
});

router.post("/campaigns/:id/send", async (req, res, next) => {
  try {
    if (!isConfigured()) return res.status(400).json({ error: "Email sender not configured" });
    const { rows: [c] } = await query("SELECT * FROM email_campaigns WHERE id=$1 AND workspace_id=$2", [req.params.id, req.workspaceId]);
    if (!c) return res.status(404).json({ error: "Campaign not found" });
    if (!["draft", "scheduled", "paused"].includes(c.status)) return res.status(409).json({ error: `Cannot send a campaign in status '${c.status}'` });
    if (!c.subject || !c.html_body) return res.status(400).json({ error: "subject and html_body required" });

    const { queueEmailCampaign } = require("../jobs/workers");
    const result = await queueEmailCampaign(c.id);
    await writeAudit({
      orgId: req.orgId, workspaceId: req.workspaceId, actorId: req.user.id, actorName: req.user.name,
      action: "email_campaign.send", entityType: "email_campaign", entityId: c.id, entityName: c.name,
      afterData: { recipients: result.total }, source: "ui",
    });
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

router.post("/campaigns/:id/schedule", async (req, res, next) => {
  try {
    const { scheduled_at } = req.body;
    const when = scheduled_at ? new Date(scheduled_at) : null;
    if (!when || isNaN(when.getTime()) || when.getTime() < Date.now()) return res.status(400).json({ error: "scheduled_at must be a future timestamp" });
    const { rows: [c] } = await query(
      "UPDATE email_campaigns SET status='scheduled', scheduled_at=$3, updated_at=NOW() WHERE id=$1 AND workspace_id=$2 AND status IN ('draft','paused') RETURNING *",
      [req.params.id, req.workspaceId, when.toISOString()]
    );
    if (!c) return res.status(409).json({ error: "Campaign not found or not schedulable" });
    res.json(c);
  } catch (err) { next(err); }
});

router.post("/campaigns/:id/pause", async (req, res, next) => {
  try {
    const { rows: [c] } = await query(
      "UPDATE email_campaigns SET status='paused', updated_at=NOW() WHERE id=$1 AND workspace_id=$2 AND status IN ('scheduled','sending') RETURNING *",
      [req.params.id, req.workspaceId]
    );
    if (!c) return res.status(409).json({ error: "Campaign not found or not pausable" });
    res.json(c);
  } catch (err) { next(err); }
});

router.get("/campaigns/:id/stats", async (req, res, next) => {
  try {
    const { rows: [c] } = await query(
      `SELECT id, name, status, recipients, sent, delivered, opened, clicked, bounced, complained, unsubscribed, sent_at
         FROM email_campaigns WHERE id=$1 AND workspace_id=$2`, [req.params.id, req.workspaceId]);
    if (!c) return res.status(404).json({ error: "Campaign not found" });
    const { rows: byStatus } = await query(
      "SELECT status, COUNT(*)::int AS n FROM email_sends WHERE campaign_id=$1 GROUP BY status", [req.params.id]);
    res.json({ ...c, sends: Object.fromEntries(byStatus.map((r) => [r.status, r.n])) });
  } catch (err) { next(err); }
});

// ─── Suppressions ─────────────────────────────────────────────────────────────
router.get("/suppressions", async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM email_suppressions WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 500", [req.workspaceId]);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.post("/suppressions", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!isEmail(email)) return res.status(400).json({ error: "valid email required" });
    await query(
      `INSERT INTO email_suppressions (workspace_id, email, reason) VALUES ($1,$2,'manual')
       ON CONFLICT (workspace_id, lower(email)) DO NOTHING`, [req.workspaceId, email]);
    await query("UPDATE email_contacts SET status='unsubscribed', updated_at=NOW() WHERE workspace_id=$1 AND lower(email)=lower($2)", [req.workspaceId, email]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete("/suppressions/:id", async (req, res, next) => {
  try {
    await query("DELETE FROM email_suppressions WHERE id=$1 AND workspace_id=$2", [req.params.id, req.workspaceId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
