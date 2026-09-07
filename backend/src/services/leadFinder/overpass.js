/**
 * Business search via the OpenStreetMap Overpass API — free, no API key, ToS-compliant.
 *
 * OSM has no free-text description of a business. What kind of place it is lives in one tag
 * (amenity=restaurant), what it serves lives in another (cuisine=chinese), and both use
 * ENGLISH values no matter what language the mapper wrote the name in. A free-text query has
 * to be translated into those tags; matching it as loose words does not work.
 *
 * This module used to split the query on spaces and OR the words together across
 * name/amenity/shop/cuisine/craft/office. Two things followed from that, and together they
 * silently turned one search into a completely different one:
 *
 *   1. OR means the BROADEST word wins. "asiatisches restaurant" became
 *      `asiatisches|restaurant`, and `amenity=restaurant` is on every restaurant on earth —
 *      so the qualifier contributed nothing and the search returned all restaurants. Measured
 *      on the live 2026-07-15 run over Germany: 500 results, 39 of them (7.8%) actually Asian,
 *      208 plain `restaurant` with no cuisine at all, and 119 of the businesses were literally
 *      the same rows as a plain "restaurant" search run four hours earlier.
 *   2. The qualifier could not have matched even under AND: OSM writes `cuisine=chinese`,
 *      not "asiatisches", so a German adjective matches no value anywhere.
 *
 * So: recognised cuisine/venue words are translated into real tag filters, and any remaining
 * free-text words are ANDed (every word must match the element) instead of ORed.
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

// ── Query interpretation ─────────────────────────────────────────────────────
// Words the user might type for a kind of food → the OSM `cuisine` values that actually
// carry that meaning. OSM values are English and snake_case; the user types German. Without
// this table no cuisine word the user writes can match anything, which is defect (2) above.
//
// Matching is by stem so German inflections work: "asiatisch", "asiatisches", "asiatische"
// all reduce to the stem "asiat". Short stems must match the whole token — a 3-letter stem
// used as a prefix would swallow unrelated words ("bar" matching "Barcelona").
const STEM_PREFIX_MIN = 5;

const CUISINE_STEMS = [
  { stems: ["asiat", "asian", "asia"],
    values: ["asian", "chinese", "vietnamese", "thai", "japanese", "korean", "sushi", "indian",
             "indonesian", "malaysian", "taiwanese", "mongolian", "ramen", "noodle", "wok",
             "dim_sum", "pho", "cantonese", "szechuan"] },
  { stems: ["chines", "china"], values: ["chinese", "cantonese", "szechuan", "dim_sum"] },
  { stems: ["vietnames", "vietnam"], values: ["vietnamese", "pho"] },
  { stems: ["thailänd", "thailaend", "thai", "thailand"], values: ["thai"] },
  { stems: ["japan"], values: ["japanese", "sushi", "ramen"] },
  { stems: ["sushi"], values: ["sushi", "japanese"] },
  { stems: ["korean", "korea"], values: ["korean"] },
  { stems: ["indisch", "indian", "indien"], values: ["indian"] },
  { stems: ["italien", "italian"], values: ["italian", "pizza"] },
  { stems: ["pizza", "pizzeria"], values: ["pizza", "italian"] },
  { stems: ["griech", "greek"], values: ["greek"] },
  { stems: ["türk", "tuerk", "turkish", "döner", "doener", "kebab"], values: ["turkish", "kebab"] },
  { stems: ["mexikan", "mexican"], values: ["mexican"] },
  { stems: ["spanisch", "spanish", "tapas"], values: ["spanish", "tapas"] },
  { stems: ["burger"], values: ["burger"] },
  { stems: ["vegan"], values: ["vegan", "vegetarian"] },
  { stems: ["vegetar"], values: ["vegetarian", "vegan"] },
];

// Words naming the kind of venue → OSM `amenity` values.
const VENUE_STEMS = [
  { stems: ["restaurant", "gaststätt", "gaststaett", "gasthaus", "gasthof", "lokal"],
    values: ["restaurant"] },
  { stems: ["imbiss", "schnellrestaurant", "fastfood", "takeaway"], values: ["fast_food"] },
  { stems: ["café", "cafe", "kaffee", "coffee"], values: ["cafe"] },
  { stems: ["bar", "kneipe", "pub"], values: ["bar", "pub"] },
];

// A cuisine search with no venue word still means "a place that serves this", so allow the
// food venues rather than every tagged object in the bbox.
const DEFAULT_FOOD_AMENITIES = ["restaurant", "fast_food", "cafe", "bar", "pub"];

function matchesStem(token, stems) {
  return stems.some((stem) =>
    token === stem || (stem.length >= STEM_PREFIX_MIN && token.startsWith(stem)));
}

function tokenize(query) {
  return String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .map(sanitizeWord)
    .filter(Boolean);
}

/**
 * Split a free-text query into the tag filters it actually means.
 * @returns {{cuisineValues: string[], amenityValues: string[], freeWords: string[], words: string[]}}
 */
function interpretQuery(query) {
  const words = tokenize(query);
  if (!words.length) throw new Error("query required");

  const cuisineValues = [];
  const amenityValues = [];
  const cuisineWords  = [];
  const freeWords     = [];

  for (const word of words) {
    const cuisine = CUISINE_STEMS.find((e) => matchesStem(word, e.stems));
    if (cuisine) { cuisineValues.push(...cuisine.values); cuisineWords.push(word); continue; }
    const venue = VENUE_STEMS.find((e) => matchesStem(word, e.stems));
    if (venue) { amenityValues.push(...venue.values); continue; }
    freeWords.push(word);
  }

  return {
    cuisineValues: [...new Set(cuisineValues)],
    amenityValues: [...new Set(amenityValues)],
    // The user's own word goes into the name pattern too: a place called "Asiatisches
    // Restaurant Lotus" or "Asia Wok" is a hit even when nobody tagged its cuisine.
    cuisineWords: [...new Set(cuisineWords)],
    freeWords,
    words,
  };
}

const BROAD_KEY_PATTERN = "^(name|amenity|shop|cuisine|craft|office)$";

// Every filter on one statement is a conjunction in Overpass QL, so one filter per word is
// AND — which is what a multi-word query means. ORing them (the old behaviour) let the
// broadest word decide the whole search.
function andWordFilters(words) {
  return words.map((w) => `[~"${BROAD_KEY_PATTERN}"~"${w}",i]`).join("");
}

function buildFilters(query) {
  const { cuisineValues, amenityValues, cuisineWords, freeWords } = interpretQuery(query);

  if (!cuisineValues.length) {
    // Nothing food-specific recognised. A named venue becomes a real amenity filter; anything
    // left over stays free-text, now ANDed. "restaurant" alone is the amenity filter and
    // nothing else — matching the bare word again across every key would only re-admit the
    // noise the amenity filter exists to exclude.
    if (amenityValues.length) {
      return `[amenity~"^(${amenityValues.join("|")})$"]` + andWordFilters(freeWords);
    }
    return andWordFilters(freeWords.length ? freeWords : tokenize(query));
  }

  // A named venue is treated as a hint, not a restriction: "sushi bar" is idiom, and the
  // places it means are tagged amenity=restaurant far more often than amenity=bar. Narrowing
  // to the literal word would answer a reasonable query with almost nothing.
  const amenities = amenityValues.length
    ? [...new Set([...amenityValues, "restaurant", "fast_food"])]
    : DEFAULT_FOOD_AMENITIES;
  // cuisine OR name, because plenty of Asian restaurants carry no cuisine tag at all — but
  // both halves are specific, unlike the old `amenity` match that let every restaurant in.
  const cuisinePattern = [...new Set([...cuisineValues, ...cuisineWords])].join("|");
  return `[amenity~"^(${amenities.join("|")})$"]`
       + `[~"^(cuisine|name)$"~"${cuisinePattern}",i]`
       + andWordFilters(freeWords);
}

function buildQuery(bbox, query, limit) {
  const { south, west, north, east } = bbox;
  const bboxStr = `${south},${west},${north},${east}`;
  const filters = buildFilters(query);
  // Capping via "out ... <limit>;" makes Overpass itself stop early instead of us fetching
  // and discarding thousands of extra elements client-side — a broad word ("shop", "restaurant")
  // over a whole-city bbox can otherwise match tens of thousands of nodes, which was slow
  // enough to blow past our own axios timeout (observed: "shop" in Hamburg timed out at 30s).
  return `[out:json][timeout:25];
(
  node${filters}(${bboxStr});
  way${filters}(${bboxStr});
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
// Connection-level refusals are the same "come back shortly" signal as a busy status, they
// just arrive before HTTP does. The public instance rate-limits by dropping TCP connections,
// and Node reports that as ECONNREFUSED with an EMPTY message — so it used to be classified
// as a hard "service unavailable", logged as `{"error":""}`, and not retried. Observed live
// on 2026-09-07: a 304-tile run over Germany was refused after ~5 tiles, then marched through
// 237 more at full speed getting nothing, and would have reported `completed` with 6 results.
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "ENETUNREACH",
]);
const RETRY_DELAYS_MS = [2000, 5000, 15000];
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
      const retryable = BUSY_STATUSES.has(status) || RETRYABLE_NETWORK_CODES.has(err.code);
      if (!retryable) {
        // err.message is empty for most socket-level failures — err.code is the only thing
        // that identifies them, so it has to be in the log.
        logger.error("leadFinder.overpass: request failed", { error: err.message, code: err.code, status });
        throw new Error("Search service unavailable, try again shortly");
      }
      logger.warn("leadFinder.overpass: busy, retrying", { status, code: err.code, attempt });
      if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  if (lastErr) {
    logger.warn("leadFinder.overpass: giving up after retries", { code: lastErr.code, status: lastErr.response?.status });
    const e = new Error("Search service is busy right now — try again in a minute");
    e.overpassBusy = true; // lets the tiled worker tell "provider refusing us" from "bad tile"
    throw e;
  }

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

module.exports = { searchBusinesses, buildQuery, buildFilters, interpretQuery };
