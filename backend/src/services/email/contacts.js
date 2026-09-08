const crypto = require("crypto");
const { query } = require("../../db/pool");

const newToken = () => crypto.randomBytes(24).toString("hex");
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());

// Shared insert path for /contacts/import, /contacts/import-file, and lead-finder's
// add-to-contacts. ON CONFLICT keeps re-imports idempotent.
//
// An address already on the list still needs the tag it is being imported under, or it
// silently drops out of the audience it was just added to: promoting the 2026-09-08 German
// lead sweep, 219 of the 3,305 addresses found were already contacts from earlier imports,
// and under a bare DO NOTHING none of them would have carried the new tag. So a conflict
// merges tags — and only tags. Consent (source, method, timestamp, IP) belongs to the first
// time this address was collected and is never rewritten, and `status` is left alone, so a
// contact who unsubscribed stays unsubscribed and out of every send (see
// resolveRecipientIds, which filters on status and the suppression list).
async function insertContacts(workspaceId, contacts, consentSource, consentMethod, ip) {
  let imported = 0, tagged = 0, skipped = 0, invalid = 0;
  for (const c of contacts) {
    const email = String(c.email || "").trim().toLowerCase();
    if (!isEmail(email)) { invalid++; continue; }
    const { rows } = await query(
      `INSERT INTO email_contacts
         (workspace_id, email, first_name, last_name, attributes, tags, status,
          consent_source, consent_method, consent_at, consent_ip, unsubscribe_token)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,NOW(),$9,$10)
       ON CONFLICT (workspace_id, lower(email)) DO UPDATE
         SET tags = ARRAY(SELECT DISTINCT unnest(email_contacts.tags || EXCLUDED.tags)),
             updated_at = NOW()
         WHERE NOT (email_contacts.tags @> EXCLUDED.tags)
       RETURNING (xmax = 0) AS inserted`,
      [workspaceId, email, c.first_name || null, c.last_name || null,
       JSON.stringify(c.attributes || {}), Array.isArray(c.tags) ? c.tags : [],
       consentSource, consentMethod, c.consent_ip || ip || null, newToken()]
    );
    // No row back means the conflict target already carried every tag being imported —
    // nothing to do, which is the ordinary re-import case.
    if (!rows.length) skipped++;
    else if (rows[0].inserted) imported++;
    else tagged++;
  }
  return { imported, tagged, skipped, invalid };
}

module.exports = { insertContacts, isEmail };
