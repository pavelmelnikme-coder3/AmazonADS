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

// No "/" or "%" in the local-part class (unlike the RFC-legal-but-vanishingly-rare quoted
// form) — keeping them out stops the match from swallowing whole URL paths (Google Maps
// links, CDN script URLs) or un-decoded percent-escapes ("%20aw@site.de" from a raw querystring
// fragment) as if they were part of the local part of an email.
const EMAIL_RE = /[a-zA-Z0-9.!#$&'*+=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;
const MAILTO_RE = /mailto:([^"'?<>\s]+)/gi;

// Third-party widget/vendor domains that show up on countless small-business sites via cookie
// consent banners (listing every processor's DPO contact) or embedded scripts — never the
// business's own address, so always noise for a prospecting list.
const JUNK_DOMAINS = [
  "example.com", "sentry.io", "wixpress.com", "schema.org", "w3.org",
  "godaddy.com", "domain.com", "yourdomain.com", "email.com", "hcaptcha.com",
  "google.com", "fb.com", "facebook.com", "vimeo.com", "trustindex.io",
];
const JUNK_SUFFIXES = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".css", ".js"];

function isJunkEmail(email) {
  const lower = email.toLowerCase();
  if (JUNK_SUFFIXES.some((s) => lower.endsWith(s))) return true;
  const [localPart, domain = ""] = lower.split("@");
  // Social-widget captions often embed escaped "\n\n@handle.tld"-shaped text (e.g. an
  // Instagram handle like "cancun.restaurants") that only regex-matches as an email because
  // the literal backslash before "n" isn't a valid local-part char, leaving a bogus 1-char
  // local part ("n@..."). Real contact emails essentially never have a 1-char local part.
  if (localPart.length < 2) return true;
  // CDN/npm version strings (e.g. "leaflet@1.0.0-rc.3") can have a letter buried in a
  // pre-release tag ("rc"), so checking the whole domain for "any letter anywhere" isn't
  // enough — a real TLD (the last label) is always alphabetic, never a bare version number.
  const lastLabel = domain.split(".").pop() || "";
  if (!/^[a-z]+$/.test(lastLabel)) return true;
  return JUNK_DOMAINS.some((d) => domain === d || domain.endsWith("." + d));
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
    for (const addr of decoded.toLowerCase().match(EMAIL_RE) || []) {
      if (!isJunkEmail(addr)) found.add(addr);
    }
  }
  for (const m of html.matchAll(EMAIL_RE)) {
    const addr = m[0].toLowerCase();
    if (!isJunkEmail(addr)) found.add(addr);
  }
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

module.exports = { fetchEmailsFromWebsite };
