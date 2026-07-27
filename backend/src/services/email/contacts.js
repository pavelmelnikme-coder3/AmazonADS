const crypto = require("crypto");
const { query } = require("../../db/pool");

const newToken = () => crypto.randomBytes(24).toString("hex");
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());

// Shared insert path for /contacts/import, /contacts/import-file, and lead-finder's
// add-to-contacts. ON CONFLICT keeps re-imports idempotent.
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

module.exports = { insertContacts, isEmail };
