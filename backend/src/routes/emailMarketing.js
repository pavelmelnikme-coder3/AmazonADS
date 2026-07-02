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
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const router = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const logger = require("../config/logger");
const { writeAudit } = require("./audit");
const { isConfigured, sendBulkEmail } = require("../services/email/provider");
const { renderHtmlForContact, applyMergeTags, contactFields } = require("../services/email/render");
const { parseContactsFile } = require("../services/email/importParser");
const { UPLOAD_ROOT, imageStorage, fileStorage, attachmentStorage, buildAttachmentList, IMAGE_EXT_BY_MIME, FILE_EXT_ALLOW } = require("../services/email/uploads");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const uploadImage = multer({ storage: imageStorage(), limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => IMAGE_EXT_BY_MIME[file.mimetype] ? cb(null, true) : cb(new Error("Unsupported file type")) });
const uploadFile = multer({ storage: fileStorage(), limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => FILE_EXT_ALLOW.includes(path.extname(file.originalname).toLowerCase()) ? cb(null, true) : cb(new Error("Unsupported file type")) });
const uploadAttachment = multer({ storage: attachmentStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

router.use(requireAuth, requireWorkspace);

const newToken = () => crypto.randomBytes(24).toString("hex");
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());

// Wraps a multer middleware so oversize/bad-type uploads come back as a clean 400 instead
// of falling through to the generic 500 handler (MulterError has no .status of its own).
const withUpload = (mw) => (req, res, next) => mw(req, res, (err) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) return res.status(400).json({ error: `Upload error: ${err.message}` });
  if (err.message === "Unsupported file type") return res.status(400).json({ error: err.message });
  next(err);
});

// Shared insert path for both /contacts/import (pasted emails) and /contacts/import-file
// (parsed spreadsheet). ON CONFLICT keeps re-imports idempotent.
async function insertContacts(workspaceId, contacts, consentSource, consentMethod, ip) {
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
      [workspaceId, email, c.first_name || null, c.last_name || null,
       JSON.stringify(c.attributes || {}), Array.isArray(c.tags) ? c.tags : [],
       consentSource, consentMethod, c.consent_ip || ip || null, newToken()]
    );
    if (rowCount) imported++; else skipped++;
  }
  return { imported, skipped, invalid };
}

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
    const result = await insertContacts(req.workspaceId, contacts, consent_source, consent_method, req.ip);
    res.json(result);
  } catch (err) { next(err); }
});

// Import from an uploaded .xlsx/.csv file — columns (email/first name/last name) are
// auto-detected from the header row; any other columns are kept as merge-tag attributes.
router.post("/contacts/import-file", withUpload(upload.single("file")), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file required (field 'file')" });
    const { consent_source, consent_method = "import" } = req.body;
    if (!consent_source) return res.status(400).json({ error: "consent_source required (GDPR proof of opt-in)" });

    let parsed;
    try { parsed = await parseContactsFile(req.file.buffer, req.file.originalname); }
    catch (e) { return res.status(400).json({ error: `Could not read file: ${e.message}` }); }
    if (!parsed.contacts.length) return res.status(400).json({ error: "No contact rows found in file" });

    const result = await insertContacts(req.workspaceId, parsed.contacts, consent_source, consent_method, req.ip);
    res.json({ ...result, detected: parsed.detected, rows: parsed.contacts.length });
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
    const { name, subject = "", from_name, from_email, reply_to, html_body = "", segment_id = null, content_blocks = null } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const { rows: [c] } = await query(
      `INSERT INTO email_campaigns (workspace_id, name, subject, from_name, from_email, reply_to, html_body, segment_id, content_blocks, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.workspaceId, name, subject, from_name || null, from_email || null, reply_to || null, html_body, segment_id,
       content_blocks ? JSON.stringify(content_blocks) : null, req.user.id]
    );
    res.status(201).json(c);
  } catch (err) { next(err); }
});

router.put("/campaigns/:id", async (req, res, next) => {
  try {
    const { name, subject, from_name, from_email, reply_to, html_body, segment_id } = req.body;
    // content_blocks needs to be explicitly settable to NULL (switching a campaign back to
    // raw-HTML mode) — COALESCE can't express "set to null", so use a presence check instead.
    const hasContentBlocks = Object.prototype.hasOwnProperty.call(req.body, "content_blocks");
    // Only editable while not in-flight.
    const { rows: [c] } = await query(
      `UPDATE email_campaigns SET
         name=COALESCE($3,name), subject=COALESCE($4,subject), from_name=COALESCE($5,from_name),
         from_email=COALESCE($6,from_email), reply_to=COALESCE($7,reply_to), html_body=COALESCE($8,html_body),
         segment_id=$9, content_blocks = CASE WHEN $10 THEN $11::jsonb ELSE content_blocks END,
         updated_at=NOW()
       WHERE id=$1 AND workspace_id=$2 AND status IN ('draft','scheduled','paused') RETURNING *`,
      [req.params.id, req.workspaceId, name ?? null, subject ?? null, from_name ?? null,
       from_email ?? null, reply_to ?? null, html_body ?? null, segment_id ?? null,
       hasContentBlocks, hasContentBlocks ? JSON.stringify(req.body.content_blocks) : null]
    );
    if (!c) return res.status(409).json({ error: "Campaign not found or not editable" });
    res.json(c);
  } catch (err) { next(err); }
});

// ─── Uploads (images / hosted files for block content) ─────────────────────────
router.post("/uploads/image", withUpload(uploadImage.single("file")), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file required (field 'file')" });
  res.json({
    url: `${process.env.APP_PUBLIC_URL || ""}/api/v1/email/uploads/images/${req.workspaceId}/${req.file.filename}`,
    filename: req.file.filename, size: req.file.size, mime: req.file.mimetype,
  });
});

router.post("/uploads/file", withUpload(uploadFile.single("file")), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file required (field 'file')" });
  res.json({
    url: `${process.env.APP_PUBLIC_URL || ""}/api/v1/email/uploads/files/${req.workspaceId}/${req.file.filename}`,
    filename: req.file.originalname, storedName: req.file.filename, size: req.file.size, mime: req.file.mimetype,
  });
});

router.delete("/campaigns/:id", async (req, res, next) => {
  try {
    const { rowCount } = await query("DELETE FROM email_campaigns WHERE id=$1 AND workspace_id=$2 AND status IN ('draft','scheduled','paused','failed')",
      [req.params.id, req.workspaceId]);
    if (!rowCount) return res.status(409).json({ error: "Campaign not found or not deletable" });
    fs.rm(path.join(UPLOAD_ROOT, "email", "attachments", req.params.id), { recursive: true, force: true },
      (e) => { if (e) logger.warn("Failed to clean up campaign attachment files", { campaignId: req.params.id, error: e.message }); });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Campaign attachments (true SMTP attachments — small files only) ───────────
router.post("/campaigns/:id/attachments", withUpload(uploadAttachment.single("file")), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file required (field 'file')" });
    const { rows: [c] } = await query(
      "SELECT attachments FROM email_campaigns WHERE id=$1 AND workspace_id=$2 AND status IN ('draft','scheduled','paused')",
      [req.params.id, req.workspaceId]);
    if (!c) { fs.unlink(req.file.path, () => {}); return res.status(409).json({ error: "Campaign not found or not editable" }); }
    const existingTotal = (c.attachments || []).reduce((s, a) => s + a.size, 0);
    if (existingTotal + req.file.size > 10 * 1024 * 1024) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "Total attachments would exceed 10MB for this campaign — use a hosted file link instead" });
    }
    const entry = {
      id: crypto.randomUUID(), filename: req.file.originalname, storedName: req.file.filename,
      mime: req.file.mimetype, size: req.file.size, uploadedAt: new Date().toISOString(),
    };
    const { rows: [updated] } = await query(
      "UPDATE email_campaigns SET attachments = attachments || $2::jsonb, updated_at=NOW() WHERE id=$1 RETURNING attachments",
      [req.params.id, JSON.stringify([entry])]);
    res.json(updated);
  } catch (err) { next(err); }
});

router.delete("/campaigns/:id/attachments/:attId", async (req, res, next) => {
  try {
    const { rows: [c] } = await query(
      "SELECT attachments FROM email_campaigns WHERE id=$1 AND workspace_id=$2 AND status IN ('draft','scheduled','paused')",
      [req.params.id, req.workspaceId]);
    if (!c) return res.status(409).json({ error: "Campaign not found or not editable" });
    const entry = (c.attachments || []).find((a) => a.id === req.params.attId);
    const remaining = (c.attachments || []).filter((a) => a.id !== req.params.attId);
    const { rows: [updated] } = await query(
      "UPDATE email_campaigns SET attachments=$2::jsonb, updated_at=NOW() WHERE id=$1 RETURNING attachments",
      [req.params.id, JSON.stringify(remaining)]);
    if (entry) fs.unlink(path.join(UPLOAD_ROOT, "email", "attachments", req.params.id, entry.storedName),
      (e) => { if (e) logger.warn("Failed to remove attachment file", { error: e.message }); });
    res.json(updated);
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
      attachments: buildAttachmentList(c.attachments, c.id),
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

// Percentage rounded to 1 decimal, or null (not 0) when the denominator is 0 — "0%" implies
// "we measured this and it was zero", which is misleading before any engagement webhook has
// landed; null lets the UI show a dash instead.
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

router.get("/campaigns/:id/stats", async (req, res, next) => {
  try {
    const { rows: [c] } = await query(
      `SELECT id, name, status, recipients, sent, delivered, opened, clicked, bounced, complained, unsubscribed, sent_at
         FROM email_campaigns WHERE id=$1 AND workspace_id=$2`, [req.params.id, req.workspaceId]);
    if (!c) return res.status(404).json({ error: "Campaign not found" });
    const { rows: byStatus } = await query(
      "SELECT status, COUNT(*)::int AS n FROM email_sends WHERE campaign_id=$1 GROUP BY status", [req.params.id]);
    // Delivered is the standard denominator for engagement rates (undelivered mail can't be
    // opened/clicked) — falls back to `sent` while no delivered-webhook has landed yet, so
    // rates aren't stuck at null forever on a provider/config that only reports opens/clicks.
    const engagedBase = c.delivered || c.sent;
    res.json({
      ...c,
      sends: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      rates: {
        deliveredRate: pct(c.delivered, c.sent),
        openRate: pct(c.opened, engagedBase),
        clickRate: pct(c.clicked, engagedBase),
        clickToOpenRate: pct(c.clicked, c.opened),
        bounceRate: pct(c.bounced, c.sent),
        complaintRate: pct(c.complained, engagedBase),
        unsubscribeRate: pct(c.unsubscribed, engagedBase),
      },
    });
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
