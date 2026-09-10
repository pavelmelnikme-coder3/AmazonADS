const crypto = require("crypto");
const { query } = require("../../db/pool");
const { classifyAddress } = require("./address");

const newToken = () => crypto.randomBytes(24).toString("hex");
// The shape gate used to be `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, which accepts anything with an "@"
// in it — `alpinejs@3.x.x`, `s*q@0.l`, `120363406267552979@g.us` and a quote-prefixed
// `'impressum@…` all passed it and reached a 3,248-address audience. address.js holds the real
// rules, shared with the scraper so the two cannot drift again.
const isEmail = (s) => classifyAddress(s).ok;

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
// @param {object} [opts]
// @param {boolean} [opts.verifyMx] - resolve each distinct domain before storing anything, and
//   drop addresses whose domain cannot receive mail at all. 98 of the 1,939 domains in the
//   asian_b2b audience resolve to nothing; every address at one of them is a guaranteed hard
//   bounce, and hard bounces are what gets a sending account suspended. Two of those domains
//   are scraper damage no character-level rule can see — `…-bonner-str.deinfo` is ".de" glued
//   to the word that followed it in the HTML. Fails open on a DNS problem (see mx.js).
async function insertContacts(workspaceId, contacts, consentSource, consentMethod, ip, opts = {}) {
  let imported = 0, tagged = 0, skipped = 0, invalid = 0;
  // Why each rejected row was rejected, so an import that quietly loses addresses can say
  // which rule took them — `invalid: 37` on its own tells the operator nothing actionable.
  const rejected = {};

  // Classify first, then resolve the surviving domains in one parallel pass — checking DNS
  // for `alpinejs@3.x.x` would be a waste of a lookup.
  const classified = contacts.map((c) => ({ contact: c, ...classifyAddress(c.email) }));
  let deliverable = null;
  if (opts.verifyMx) {
    const { partitionByMx } = require("./mx");
    ({ deliverable } = await partitionByMx(classified.filter((c) => c.ok).map((c) => c.email)));
  }

  for (const { contact: c, email, ok, reason } of classified) {
    // classifyAddress repairs what it can (a scraped `'impressum@site.de` is a real address
    // wearing a stray quote) and names the rule when it can't.
    if (!ok) { invalid++; rejected[reason] = (rejected[reason] || 0) + 1; continue; }
    if (deliverable && !deliverable.has(email)) {
      invalid++; rejected.no_mail_exchanger = (rejected.no_mail_exchanger || 0) + 1; continue;
    }
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
  return { imported, tagged, skipped, invalid, rejected };
}

module.exports = { insertContacts, isEmail };
