/**
 * Business search via the OpenStreetMap Overpass API — free, no API key, ToS-compliant.
 * A free-text query ("sushi restaurant", "car repair shop") is split into words and matched
 * as a case-insensitive OR across the tags most likely to describe a business
 * (name/amenity/shop/cuisine/craft/office), since OSM tags are single-word values spread
 * across different keys rather than one free-text field.
 */
const axios = require("axios");
const logger = require("../../config/logger");

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const USER_AGENT = "AdsFlow/1.0 (contact: 89pavelmelnik@gmail.com)";

// Strip regex metacharacters rather than escape them: Overpass QL's own string-literal
// parser doesn't reliably preserve backslash-escaped regex metachars through to the PCRE
// engine (observed empirically — "\+" survives the QL layer as a bare "+", which the regex
// engine then rejects as an invalid dangling quantifier, 400ing the whole search). Since this
// is loose free-text word matching, not precise regex authoring, dropping metacharacters is
// harmless — "car+wash" just becomes "carwash", a lone "+" or "\"" token disappears entirely.
function sanitizeWord(w) {
  return w.replace(/[^\p{L}\p{N}'-]/gu, "");
}

function buildValuePattern(query) {
  const words = String(query || "")
    .split(/\s+/)
    .map(sanitizeWord)
    .filter(Boolean);
  if (!words.length) throw new Error("query required");
  return words.join("|");
}

function buildQuery(bbox, query, limit) {
  const { south, west, north, east } = bbox;
  const bboxStr = `${south},${west},${north},${east}`;
  const valuePattern = buildValuePattern(query);
  const keyPattern = "^(name|amenity|shop|cuisine|craft|office)$";
  // Capping via "out ... <limit>;" makes Overpass itself stop early instead of us fetching
  // and discarding thousands of extra elements client-side — a broad word ("shop", "restaurant")
  // over a whole-city bbox can otherwise match tens of thousands of nodes, which was slow
  // enough to blow past our own axios timeout (observed: "shop" in Hamburg timed out at 30s).
  return `[out:json][timeout:25];
(
  node[~"${keyPattern}"~"${valuePattern}",i](${bboxStr});
  way[~"${keyPattern}"~"${valuePattern}",i](${bboxStr});
);
out center tags ${limit};`;
}

function pickCategory(tags) {
  const base = tags.amenity || tags.shop || tags.craft || tags.office || null;
  if (base && tags.cuisine) return `${base} (${tags.cuisine})`;
  return base || tags.cuisine || null;
}

function pickAddress(tags) {
  const parts = [
    [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" "),
    tags["addr:postcode"],
    tags["addr:city"],
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/**
 * @returns {Promise<Array<{osm_type, osm_id, name, category, address, lat, lon, website, phone}>>}
 *
 * The free public overpass-api.de instance is shared load-balanced infrastructure and
 * empirically flaky under load — it can return a transient 406/429/503/504 for a request
 * that's perfectly well-formed. A couple of short retries absorb that instead of surfacing
 * "busy" to the user on the first hiccup.
 */
const BUSY_STATUSES = new Set([406, 429, 503, 504]);
const RETRY_DELAYS_MS = [2000, 5000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function searchBusinesses({ bbox, query, limit = 501 }) {
  const overpassQuery = buildQuery(bbox, query, limit);
  const body = `data=${encodeURIComponent(overpassQuery)}`;

  let resp;
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      resp = await axios.post(OVERPASS_URL, body, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
          "User-Agent": USER_AGENT,
        },
        timeout: 30000,
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      // A client-side timeout (ECONNABORTED, no response at all) means THIS query is just
      // expensive — a broad word's regex has to be tested against every tagged element in a
      // whole-city bbox, with no index to help. Retrying re-runs the same slow query and only
      // triples the wait for the same outcome, unlike a busy HTTP status where the server-side
      // condition is likely to clear a few seconds later — so only those get retried.
      if (err.code === "ECONNABORTED") {
        logger.warn("leadFinder.overpass: query timed out (not retrying)", { query });
        throw new Error("Search timed out — try a more specific business type or a smaller region");
      }
      if (!BUSY_STATUSES.has(status)) {
        logger.error("leadFinder.overpass: request failed", { error: err.message, status });
        throw new Error("Search service unavailable, try again shortly");
      }
      logger.warn("leadFinder.overpass: busy, retrying", { status, attempt });
      if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  if (lastErr) throw new Error("Search service is busy right now — try again in a minute");

  // Overpass doesn't always fail loudly on an internal timeout — for very large bboxes (e.g. a
  // whole-country region from Nominatim) it can return HTTP 200 with an EMPTY elements array
  // and a "remark" explaining it gave up after its own [timeout:25] budget. Left unchecked this
  // silently looks like a legitimate "0 results found" instead of the truncated-scan it is.
  if (resp.data?.remark?.includes("timed out")) {
    logger.warn("leadFinder.overpass: server-side query timeout (200 + remark)", { query, remark: resp.data.remark });
    throw new Error("Search timed out — the region is too large for this query, try a smaller region or more specific business type");
  }

  const elements = resp.data?.elements || [];
  const results = [];
  for (const el of elements) {
    const tags = el.tags || {};
    if (!tags.name) continue; // unnamed matches aren't useful leads
    const lat = el.type === "node" ? el.lat : el.center?.lat;
    const lon = el.type === "node" ? el.lon : el.center?.lon;
    results.push({
      osm_type: el.type,
      osm_id: el.id,
      name: tags.name,
      category: pickCategory(tags),
      address: pickAddress(tags),
      lat: lat ?? null,
      lon: lon ?? null,
      website: tags.website || tags["contact:website"] || null,
      phone: tags.phone || tags["contact:phone"] || null,
    });
  }
  return results;
}

module.exports = { searchBusinesses };
