/**
 * Does this domain accept mail at all?
 *
 * A syntactically perfect address at a domain with no mail exchanger is a guaranteed hard
 * bounce, and hard bounces are the metric that gets a sending account suspended — Brevo acts
 * around 5%, and the July campaign came in at 6.3% (125 of 1,990). Checking DNS before an
 * address is stored costs one lookup per domain and removes those bounces entirely.
 *
 * Of the 1,939 domains in the asian_b2b audience, 98 resolve to nothing at all. Some are
 * restaurants that have since closed; others are scraper damage that no syntax rule can catch,
 * because the wreckage is still shaped like a domain:
 *   asia-thaigourmet-bonner-str.deinfo   ".de" glued to the "info" that followed it in the HTML
 *   berliner-pilsner.den                 ".de" plus a stray "n"
 * Both pass every character-level check there is. DNS is what tells them apart from a real one.
 *
 * Fails OPEN. A SERVFAIL, a timeout or a rate-limited resolver says nothing about the domain,
 * and dropping a real lead over a DNS blip is worse than keeping one bad address: only an
 * authoritative "this name does not exist" (NXDOMAIN) or "it exists with no usable record"
 * (NODATA, i.e. no MX and no A/AAAA) counts as a rejection.
 */
const dns = require("dns").promises;
const logger = require("../../config/logger");

// Cache per process: an import of 3,000 restaurant addresses covers far fewer distinct domains,
// and the free-mail providers repeat hundreds of times each.
const _cache = new Map();

const NOT_FOUND = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

async function resolves(domain, kind) {
  try {
    const r = kind === "MX" ? await dns.resolveMx(domain)
            : kind === "A" ? await dns.resolve4(domain)
            : await dns.resolve6(domain);
    return { ok: Array.isArray(r) && r.length > 0, authoritative: true };
  } catch (err) {
    // An authoritative "no such record" is a real answer; anything else (SERVFAIL, REFUSED,
    // timeout) is the resolver having a bad day and must not count against the domain.
    return { ok: false, authoritative: NOT_FOUND.has(err.code) };
  }
}

/**
 * @returns {Promise<boolean>} true when the domain can receive mail, or when DNS could not
 *   give a trustworthy answer (fail open).
 */
async function acceptsMail(domain) {
  const d = String(domain || "").toLowerCase().trim();
  if (!d) return false;
  if (_cache.has(d)) return _cache.get(d);

  const mx = await resolves(d, "MX");
  let verdict;
  if (mx.ok) verdict = true;
  else if (!mx.authoritative) verdict = true; // resolver trouble — keep the address
  else {
    // RFC 5321 §5.1: with no MX, the address record is the implicit mail exchanger.
    const a = await resolves(d, "A");
    if (a.ok) verdict = true;
    else if (!a.authoritative) verdict = true;
    else verdict = (await resolves(d, "AAAA")).ok;
  }
  _cache.set(d, verdict);
  return verdict;
}

/** Same question, asked about a full address. */
function domainOf(email) {
  const at = String(email || "").lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1);
}

/**
 * Filter a list of addresses down to the ones whose domain can receive mail, resolving each
 * distinct domain once and in parallel.
 * @returns {Promise<{ deliverable: Set<string>, deadDomains: string[] }>} keyed by lowercased address
 */
async function partitionByMx(emails, { concurrency = 20 } = {}) {
  const domains = [...new Set(emails.map((e) => domainOf(String(e || "").toLowerCase())).filter(Boolean))];
  const dead = [];
  for (let i = 0; i < domains.length; i += concurrency) {
    const slice = domains.slice(i, i + concurrency);
    const verdicts = await Promise.all(slice.map((d) => acceptsMail(d)));
    slice.forEach((d, n) => { if (!verdicts[n]) dead.push(d); });
  }
  const deadSet = new Set(dead);
  const deliverable = new Set(
    emails.map((e) => String(e || "").toLowerCase()).filter((e) => !deadSet.has(domainOf(e))));
  if (dead.length) logger.info("MX check rejected domains that cannot receive mail", { domains: dead.length });
  return { deliverable, deadDomains: dead };
}

module.exports = { acceptsMail, partitionByMx, domainOf, _cache };
