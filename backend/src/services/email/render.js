/**
 * Marketing-email HTML rendering: per-recipient merge tags + the legally-required
 * footer (physical postal address + one-click unsubscribe link). Kept separate from
 * the transactional templates in services/email.js.
 */

// Mirror of the esc() helper used in services/email.js — escape user/contact data.
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Public unsubscribe URL for a contact's opaque token (RFC 8058 link target).
function unsubscribeUrl(token) {
  const base = (process.env.APP_PUBLIC_URL || "").replace(/\/+$/, "");
  return `${base}/api/v1/email/unsubscribe/${encodeURIComponent(token)}`;
}

// Replace {{key}} merge tags from a flat field map (first_name, last_name, email, + attributes).
// Unknown tags collapse to empty string so a missing field never leaks "{{x}}" into an email.
function applyMergeTags(html, fields) {
  return String(html || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = fields[key];
    return v == null ? "" : esc(String(v));
  });
}

function contactFields(contact) {
  const attrs = contact.attributes && typeof contact.attributes === "object" ? contact.attributes : {};
  return {
    email: contact.email,
    first_name: contact.first_name || "",
    last_name: contact.last_name || "",
    ...attrs,
  };
}

/**
 * Render the final HTML for one recipient: merge tags applied + a compliance footer
 * appended (postal address from COMPANY_POSTAL_ADDRESS + unsubscribe link). The footer
 * is always added so every marketing email is legally complete even if the author omits it.
 */
function renderHtmlForContact(htmlBody, contact) {
  const body = applyMergeTags(htmlBody, contactFields(contact));
  const addr = process.env.COMPANY_POSTAL_ADDRESS || "";
  const unsub = unsubscribeUrl(contact.unsubscribe_token);
  const footer = `
  <div style="margin-top:28px;padding-top:14px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    ${addr ? `<div style="margin-bottom:6px;">${esc(addr)}</div>` : ""}
    <div>You are receiving this because you opted in. <a href="${esc(unsub)}" style="color:#64748b;">Unsubscribe</a>.</div>
  </div>`;
  return `${body}${footer}`;
}

module.exports = { esc, unsubscribeUrl, applyMergeTags, contactFields, renderHtmlForContact };
