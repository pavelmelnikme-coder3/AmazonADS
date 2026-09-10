/**
 * One address validator, shared by everything that can put an email into email_contacts:
 * the lead-finder's website scraper (services/leadFinder/emailScraper.js) and the import
 * path (services/email/contacts.js). Two separate gates drifted apart once already — the
 * scraper grew a junk filter while `isEmail` stayed `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, which
 * accepts almost anything with an "@" in it — so the rules live here and nowhere else.
 *
 * What actually got through into the 3,248-address asian_b2b audience, and what each rule
 * below is here to stop:
 *   'impressum@asia-lieferservice-bayreuth.de   a JS string literal's quote stuck to the front
 *   #buchhaltung@kinhdo-gmbh.de                 same, from a fragment href
 *   alpinejs@3.x.x                              an npm package spec in a <script> tag
 *   s*q@0.l                                     two fragments of minified CSS either side of an @
 *   120363406267552979@g.us                     a WhatsApp group JID from a chat widget
 *   info@chichikan.d                            a truncated .de
 *   privacyquestions@cloudflare.com             a cookie banner's list of processors
 *   privacy@fontawesome.com, dpo@wordpress.org  the same, from embedded vendor scripts
 *   example@mysite.com, name@example.de         a website template's untouched placeholder
 *
 * The first two are real addresses wearing a stray character, so normalizeAddress() repairs
 * them instead of dropping the lead. The rest are not addresses of a business at all, and
 * classifyAddress() rejects them with a reason the caller can count and report.
 */

// RFC 5322 permits far more than this in a local part (!#$%&'*+-/=?^_`{|}~ and quoted forms).
// Deliberately narrower: every character outside this set, in practice, means the match came
// out of code or markup rather than off a contact page. `'` stays — o'brien@… is a real name.
const LOCAL_RE = /^[a-z0-9](?:[a-z0-9._+'-]*[a-z0-9])?$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A real TLD is alphabetic and at least two characters. This one rule is what rejects every
// npm/CDN version string — alpinejs@3.x.x, leaflet@1.0.0, swiper@8.4.5 — without having to
// guess at version shapes, and it keeps 163.com and 126.com (a numeric label is fine, a
// numeric *last* label is not).
const TLD_RE = /^[a-z]{2,}$/;

// Vendor, platform and widget domains that appear on small-business sites via cookie-consent
// banners (which list every processor's DPO address), embedded scripts and social widgets.
// Never the business's own address — and a cold B2B mail to a DPO inbox at one of these is a
// spam complaint from a company with a department for handling them.
const VENDOR_DOMAINS = new Set([
  // observed in the asian_b2b sweep
  "cloudflare.com", "fontawesome.com", "wordpress.org", "g.us",
  "freehtml5.co", "readymag.com", "spotify.com", "techaro.lol",
  // delivery platforms, booking portals and review sites: a restaurant's site links to them,
  // so their corporate addresses get harvested alongside the restaurant's own
  "deliveroo.fr", "deliveroo.com", "deliveroo.de", "lieferando.de", "ubereats.com",
  "opentable.com", "opentable.de", "thefork.com", "tripadvisor.com", "tripadvisor.de",
  "yelp.com", "yelp.de", "liefern.in", "gourmetguide.com",
  // template and stock-asset vendors whose demo markup ships with an address in it
  "colorlib.com", "templatemo.com", "bootstrapmade.com", "themeforest.net", "envato.com",
  "unsplash.com", "pexels.com", "freepik.com",
  // payment, mail and CRM vendors named in checkout and privacy text
  "stripe.com", "paypal.com", "klarna.com", "mollie.com", "mailchimp.com", "klaviyo.com",
  "hubspot.com", "brevo.com", "sendinblue.com",
  // consent/analytics/script vendors whose notices carry contact addresses
  "wordpress.com", "automattic.com", "cookiebot.com", "usercentrics.com", "borlabs.io",
  "e-recht24.de", "sentry.io", "hcaptcha.com", "recaptcha.net", "gravatar.com",
  "trustindex.io", "schema.org", "w3.org", "jquery.com", "bootstrapcdn.com", "jsdelivr.net",
  // site builders and hosts
  "wix.com", "wixpress.com", "squarespace.com", "jimdo.com", "shopify.com", "webflow.com",
  "godaddy.com", "ionos.de", "ionos.com", "strato.de", "hostinger.com", "typo3.org",
  "elementor.com", "webnode.com", "weebly.com",
  // social/media embeds
  "facebook.com", "fb.com", "instagram.com", "youtube.com", "vimeo.com", "twitter.com",
  "x.com", "linkedin.com", "tiktok.com", "pinterest.com", "whatsapp.com",
  "google.com", "googleapis.com", "gstatic.com",
]);

// Addresses a website template ships with and nobody ever replaced.
const PLACEHOLDER_DOMAINS = new Set([
  "example.com", "example.de", "example.org", "example.net", "mysite.com", "yourdomain.com",
  "your-domain.com", "yourcompany.com", "domain.com", "email.com", "test.com", "mail.example.com",
  "firma.de", "musterfirma.de", "beispiel.de", "beispiel.com", "beispiel.org",
  "deinedomain.de", "ihre-domain.de", "meinedomain.de", "company.com", "yourcompany.de",
  "ihrefirma.de", "meinefirma.de",
  // "Beispielshop" is the demo storefront a German shop system ships with. Whole-word matching
  // on "beispiel.de" does not reach it, and it arrived twice under a real brand name as its
  // first_name — a reminder that a plausible display name says nothing about the address.
  "beispielshop.de", "beispielshop.com", "mustershop.de", "musterhaus.de", "testshop.de",
]);

// Mailboxes nobody reads, and local parts a template shipped with. Checked independently of the
// domain, because these turn up at otherwise-real domains: `no-reply@readymag.com` and
// `youremail@gmail.com` both came out of the asian_b2b sweep.
//
// Deliberately NOT on this list: admin@, webmaster@, info@ and the like at a business's own
// domain. `webmaster@haimaisgarten.de` and `admin@nuttsthaikitchen.de` are plausibly the one
// mailbox a small restaurant actually reads, and a rule that drops them costs real prospects.
const UNREACHABLE_LOCALS = new Set([
  "noreply", "no-reply", "no_reply", "donotreply", "do-not-reply", "postmaster",
  "mailer-daemon", "mailerdaemon", "abuse", "bounce", "bounces",
  "youremail", "your-email", "yourname", "your-name", "deine-email", "ihre-email",
  "beispiel", "muster", "mustermann", "vorname.nachname", "firstname.lastname",
  "username", "yourusername", "email", "e-mail",
  // The German placeholder family, which is what a form label leaves behind: "Ihre E-Mail:
  // ihre@email.de". The domain cannot be the rule here — email.de and mail.de are real
  // providers carrying eight real restaurants in this very list (tokiosushi@mail.de,
  // silk-road@mail.de) — so the pronoun in the local part is the only thing that separates
  // the template from the customer. No German business reads a mailbox called "ihre@".
  "ihre", "ihr", "deine", "dein", "meine", "mein", "unsere", "unser", "andere", "you", "your",
  "max.mustermann", "maxmustermann", "erika.mustermann", "vorname", "nachname",
  "dummy", "lorem", "ipsum", "sample", "placeholder", "changeme", "change-me",
]);

// Filenames the address regex can swallow whole when an "@" sits next to one — image@2x.png
// is the classic, and .png/.jpg/.css/.js all pass a plain TLD check.
const FILE_SUFFIXES = [
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".ico", ".css", ".js", ".mjs",
  ".json", ".php", ".html", ".htm", ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".webm", ".pdf",
];

// A chat-platform JID or a phone number, not a mailbox. QQ's numeric addresses top out around
// 11 digits, so the floor sits well clear of them.
const NUMERIC_LOCAL_MAX = 14;

/**
 * Repair an address that is real but arrived with markup stuck to it, and give up on one that
 * is not an address at all. Lowercases, unwraps <…>/"…"/'…', and strips characters that are
 * legal inside a local part but never start or end one. Returns null when nothing usable is left.
 */
function normalizeAddress(raw) {
  let s = String(raw == null ? "" : raw).trim().toLowerCase();
  // mailto: prefixes and a trailing querystring ("?subject=…") both travel with scraped hrefs.
  s = s.replace(/^mailto:/, "").split("?")[0].trim();
  // Unwrap one layer of the usual containers, then drop any stray quoting left over.
  s = s.replace(/^[<"'`(\[{]+/, "").replace(/[>"'`)\]}]+$/, "").trim();
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) return null;
  // Trim only at the edges: `'impressum` → `impressum`, `site.de.` → `site.de`. An interior
  // character is left alone, so the shape check below still sees (and rejects) `s*q`.
  const local = s.slice(0, at).replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "");
  const domain = s.slice(at + 1).replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "");
  if (!local || !domain) return null;
  return `${local}@${domain}`;
}

/** Strict shape check on an already-normalized address. */
function hasDeliverableShape(email) {
  const at = String(email || "").lastIndexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || email.length > 254) return false;
  if (local.includes("..") || !LOCAL_RE.test(local)) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((l) => LABEL_RE.test(l))) return false;
  return TLD_RE.test(labels[labels.length - 1]);
}

/** The registrable-ish domain test used for vendor/placeholder lists: exact or a subdomain of. */
function domainMatches(domain, set) {
  if (set.has(domain)) return true;
  const parts = domain.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    if (set.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

/**
 * Normalize, then judge. One call so every entry point agrees on both halves.
 * @returns {{ email: string|null, ok: boolean, reason: string|null }}
 *   reason is a stable slug for counting and reporting: unparseable | bad_shape | file_name |
 *   vendor_domain | placeholder_domain | numeric_id | unreachable_local
 */
function classifyAddress(raw) {
  const email = normalizeAddress(raw);
  if (!email) return { email: null, ok: false, reason: "unparseable" };
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const local = email.slice(0, email.lastIndexOf("@"));
  if (FILE_SUFFIXES.some((s) => email.endsWith(s))) return { email, ok: false, reason: "file_name" };
  if (!hasDeliverableShape(email)) return { email, ok: false, reason: "bad_shape" };
  if (/^\d+$/.test(local) && local.length > NUMERIC_LOCAL_MAX) return { email, ok: false, reason: "numeric_id" };
  if (domainMatches(domain, VENDOR_DOMAINS)) return { email, ok: false, reason: "vendor_domain" };
  if (domainMatches(domain, PLACEHOLDER_DOMAINS)) return { email, ok: false, reason: "placeholder_domain" };
  if (UNREACHABLE_LOCALS.has(local)) return { email, ok: false, reason: "unreachable_local" };
  return { email, ok: true, reason: null };
}

/** Convenience predicate for callers that only need yes/no. */
function isSendableAddress(raw) {
  return classifyAddress(raw).ok;
}

module.exports = {
  classifyAddress, isSendableAddress, normalizeAddress, hasDeliverableShape,
  VENDOR_DOMAINS, PLACEHOLDER_DOMAINS, UNREACHABLE_LOCALS, FILE_SUFFIXES,
};
