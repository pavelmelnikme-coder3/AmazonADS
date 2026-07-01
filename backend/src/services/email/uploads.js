/**
 * Disk storage + path-safe serving helpers for email campaign uploads (images, hosted
 * files, and true SMTP attachments). Files live under backend/uploads/email/... which is
 * bind-mounted into the container (./backend:/app), so they persist across restarts —
 * same durability the rest of the app already relies on.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

// Overridable so tests can point this at a throwaway temp dir instead of writing into
// the real backend/uploads/ during a test run.
const UPLOAD_ROOT = process.env.EMAIL_UPLOAD_ROOT || path.join(__dirname, "..", "..", "..", "uploads");

function ensureDir(subpath) {
  const dir = path.join(UPLOAD_ROOT, subpath);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const IMAGE_EXT_BY_MIME = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
const FILE_EXT_ALLOW = [".pdf", ".ppt", ".pptx", ".xls", ".xlsx"];

function extFor(mimetype, originalname) {
  return IMAGE_EXT_BY_MIME[mimetype] || path.extname(originalname || "").toLowerCase();
}

// `subpathFn(req)` is resolved per-request so the same storage engine can be reused
// across workspaces/campaigns without baking an id in at construction time.
function diskStorageUnder(subpathFn) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      try { cb(null, ensureDir(subpathFn(req))); }
      catch (e) { cb(e); }
    },
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${extFor(file.mimetype, file.originalname)}`),
  });
}

const imageStorage = () => diskStorageUnder((req) => path.join("email", "images", req.workspaceId));
const fileStorage = () => diskStorageUnder((req) => path.join("email", "files", req.workspaceId));
const attachmentStorage = () => diskStorageUnder((req) => path.join("email", "attachments", req.params.id));

// Maps a campaign's `attachments` jsonb column to nodemailer's {filename, path} shape.
function buildAttachmentList(attachmentsJsonb, campaignId) {
  return (attachmentsJsonb || []).map((a) => ({
    filename: a.filename,
    path: path.join(UPLOAD_ROOT, "email", "attachments", campaignId, a.storedName),
  }));
}

// Filenames are always our own crypto.randomUUID()-generated names — a strict allow-list
// regex plus a resolved-path prefix check is sufficient to rule out traversal.
const SAFE_ID_RE = /^[a-zA-Z0-9-]+$/;
const SAFE_NAME_RE = /^[a-zA-Z0-9-]+\.[a-zA-Z0-9]{2,5}$/;

function resolveUploadPath(subdir, id, filename) {
  if (!SAFE_ID_RE.test(id) || !SAFE_NAME_RE.test(filename)) return null;
  const base = path.join(UPLOAD_ROOT, "email", subdir);
  const full = path.resolve(base, id, filename);
  if (!full.startsWith(base + path.sep)) return null;
  return fs.existsSync(full) ? full : null;
}

module.exports = {
  UPLOAD_ROOT, ensureDir, imageStorage, fileStorage, attachmentStorage,
  buildAttachmentList, resolveUploadPath, IMAGE_EXT_BY_MIME, FILE_EXT_ALLOW,
};
