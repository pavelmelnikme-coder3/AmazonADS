/**
 * Marketing-email HTML rendering: per-recipient merge tags + the legally-required
 * footer (physical postal address + one-click unsubscribe link). Kept separate from
 * the transactional templates in services/email.js.
 */

// Mirror of the esc() helper used in services/email.js — escape user/contact data.
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Base the public links are built on. APP_PUBLIC_URL is what a RECIPIENT's mail client will
// open, so it has to be reachable from outside; FRONTEND_URL is a usable stand-in on a
// deployment that has not set it, and is better than emitting a host-less relative URL —
// which is a dead link in an email and an invalid RFC 8058 List-Unsubscribe header value.
function publicBase() {
  return (process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || "").replace(/\/+$/, "");
}

// Public unsubscribe URL for a contact's opaque token (RFC 8058 link target).
function unsubscribeUrl(token) {
  return `${publicBase()}/api/v1/email/unsubscribe/${encodeURIComponent(token)}`;
}

// "View in browser" URL for a campaign. Keyed by the recipient's own opaque token as well as
// the campaign, so the link is not an enumerable id and the page can only be reached by
// someone who was actually sent the email.
function mirrorUrl(campaignId, token) {
  if (!campaignId || !token) return "";
  return `${publicBase()}/api/v1/email/campaigns/${encodeURIComponent(campaignId)}`
       + `/mirror/${encodeURIComponent(token)}`;
}

// Replace {{key}} merge tags from a flat field map (first_name, last_name, email, + attributes).
// Unknown tags collapse to empty string so a missing field never leaks "{{x}}" into an email.
function applyMergeTags(html, fields) {
  return String(html || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = fields[key];
    return v == null ? "" : esc(String(v));
  });
}

function contactFields(contact, opts = {}) {
  const attrs = contact.attributes && typeof contact.attributes === "object" ? contact.attributes : {};
  return {
    email: contact.email,
    first_name: contact.first_name || "",
    last_name: contact.last_name || "",
    ...attrs,
    // `unsubscribe` and `mirror` are what the templates in this project actually use, and they
    // were NOT merge tags: applyMergeTags substituted contact fields only, so both collapsed to
    // the empty string and shipped as `href=""`. The one campaign sent so far went to 1070
    // recipients with two dead links (checked 2026-09-07). Contact attributes cannot shadow
    // these — a stray `unsubscribe` column must not be able to redirect the opt-out link.
    unsubscribe: unsubscribeUrl(contact.unsubscribe_token),
    mirror: mirrorUrl(opts.campaignId, contact.unsubscribe_token),
  };
}

// The compliance footer is appended to every marketing email, so it is the one piece of the
// message this code writes rather than the campaign author — and it shipped hardcoded English
// under a German campaign. Kept deliberately small: this is legal boilerplate, not UI copy, so
// it lives here rather than pulling the frontend's i18n bundle into the mail path.
const FOOTER_TEXT = {
  en: { optIn: "You are receiving this because you opted in.", unsubscribe: "Unsubscribe",
        test: "[TEST] Unsubscribe and view-in-browser links are inert in test sends — they only work for real recipients." },
  de: { optIn: "Sie erhalten diese E-Mail, weil Sie sich dafür angemeldet haben.", unsubscribe: "Abmelden",
        test: "[TEST] Abmelde- und Browser-Links sind in Testsendungen inaktiv — sie funktionieren nur für echte Empfänger." },
  ru: { optIn: "Вы получаете это письмо, потому что подписались на рассылку.", unsubscribe: "Отписаться",
        test: "[TEST] Ссылки отписки и «открыть в браузере» в тестовой отправке неактивны — они работают только для реальных получателей." },
};

// Order of preference: what the caller asked for, then what the contact itself says (an
// imported `locale`/`lang` attribute), then the deployment default, then English. Unknown
// values fall through rather than rendering an empty footer.
function resolveLocale(contact, opts = {}) {
  const attrs = contact?.attributes && typeof contact.attributes === "object" ? contact.attributes : {};
  const candidates = [opts.locale, attrs.locale, attrs.lang, process.env.MAIL_DEFAULT_LOCALE, "en"];
  for (const c of candidates) {
    const key = String(c || "").slice(0, 2).toLowerCase();
    if (FOOTER_TEXT[key]) return key;
  }
  return "en";
}

/**
 * Render the final HTML for one recipient: merge tags applied + a compliance footer
 * appended (postal address from COMPANY_POSTAL_ADDRESS + unsubscribe link). The footer
 * is always added so every marketing email is legally complete even if the author omits it.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.isTest] - test sends use a throwaway token with no matching
 *   contact row, so a real unsubscribe link would always resolve to "expired or invalid".
 *   Show a plain note instead of a dead link so that isn't mistaken for a bug.
 */
function renderHtmlForContact(htmlBody, contact, opts = {}) {
  const body = applyMergeTags(htmlBody, contactFields(contact, opts));
  const addr = process.env.COMPANY_POSTAL_ADDRESS || "";
  const txt = FOOTER_TEXT[resolveLocale(contact, opts)];
  const unsubLine = opts.isTest
    ? `<div>${esc(txt.test)}</div>`
    : `<div>${esc(txt.optIn)} <a href="${esc(unsubscribeUrl(contact.unsubscribe_token))}" style="color:#64748b;">${esc(txt.unsubscribe)}</a>.</div>`;
  const footer = `
  <div style="margin-top:28px;padding-top:14px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    ${addr ? `<div style="margin-bottom:6px;">${esc(addr)}</div>` : ""}
    ${unsubLine}
  </div>`;
  return `${body}${footer}`;
}

module.exports = { esc, publicBase, unsubscribeUrl, mirrorUrl, applyMergeTags, contactFields, renderHtmlForContact, resolveLocale, FOOTER_TEXT };
