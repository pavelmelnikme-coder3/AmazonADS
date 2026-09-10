/**
 * Fetch a single business website and pull public contact emails out of the HTML.
 * These are ordinary small-business sites (not a hardened target like Amazon), so a
 * single polite request with a normal browser UA is enough — no anti-detection needed.
 * Callers are responsible for pacing requests across a batch (see routes/leadFinder.js).
 */
const axios = require("axios");
const logger = require("../../config/logger");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// The local-part class is deliberately the same set address.js accepts, and no wider. It used
// to span the full RFC-legal punctuation (!#$&*=?^`{|}~) and the `+` quantifier is greedy
// leftwards, so in `var m='impressum@site.de'` the match began at `m=` — every one of those
// characters was in the class. normalizeAddress() strips junk off the *edges* of a local part
// but will not cut into the middle of one (it would happily turn a real `foo!bar@site.de` into
// `bar@site.de` and mail a stranger), so `m='impressum` could only be rejected outright, and
// the lead was lost. With the class narrowed, the match starts at `'impressum` — a single
// stray quote on the edge, which is exactly what normalizeAddress is for. "/" and "%" stay out
// so a match can't swallow a URL path or an un-decoded percent-escape.
const EMAIL_RE = /[a-zA-Z0-9._+'-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;
const MAILTO_RE = /mailto:([^"'?<>\s]+)/gi;

// Junk classification and normalization both live in services/email/address.js, shared with
// the import path — the two gates drifted apart once (this file grew a filter while the import
// path's `isEmail` accepted anything with an "@" in it), and a scraped address reaches
// email_contacts through both.
const { classifyAddress } = require("../email/address");

// Keep whatever the classifier could repair ('impressum@site.de → impressum@site.de) and
// drop the rest, so a stray quote off a JS string no longer costs a real lead.
function keepAddress(raw, found) {
  const { email, ok } = classifyAddress(raw);
  if (ok) found.add(email);
}

function extractEmails(html) {
  const found = new Set();
  for (const m of html.matchAll(MAILTO_RE)) {
    // A single malformed mailto (bad percent-encoding — not uncommon in hand-rolled HTML)
    // must not abort extraction for the whole page; the plain EMAIL_RE pass below still runs.
    let decoded;
    try { decoded = decodeURIComponent(m[1]); } catch { continue; }
    // Re-run EMAIL_RE over the decoded text rather than trusting it whole: a percent-encoded
    // trailing character (e.g. "%5C" decoding to a literal backslash) would otherwise get
    // appended straight onto an otherwise-valid address ("info@site.de\") since mailto hrefs
    // aren't required to contain nothing but the address.
    for (const addr of decoded.toLowerCase().match(EMAIL_RE) || []) keepAddress(addr, found);
  }
  for (const m of html.matchAll(EMAIL_RE)) keepAddress(m[0].toLowerCase(), found);
  return [...found];
}

function normalizeUrl(url) {
  const trimmed = String(url || "").trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * @returns {Promise<{ status: 'found'|'no_email'|'error', emails: string[] }>}
 */
async function fetchEmailsFromWebsite(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) return { status: "error", emails: [] };

  try {
    const resp = await axios.get(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      timeout: 8000,
      maxRedirects: 5,
      validateStatus: (s) => s < 500,
    });

    if (resp.status >= 400) return { status: "error", emails: [] };

    const emails = extractEmails(String(resp.data || ""));
    return { status: emails.length ? "found" : "no_email", emails };
  } catch (err) {
    logger.warn("leadFinder.emailScraper: fetch failed", { url, error: err.message });
    return { status: "error", emails: [] };
  }
}

module.exports = { fetchEmailsFromWebsite, extractEmails };
