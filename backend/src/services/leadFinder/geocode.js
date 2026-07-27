/**
 * Region → bounding box, via OpenStreetMap Nominatim.
 * Usage policy (https://operations.osmfoundation.org/policies/nominatim/) requires an
 * identifying User-Agent and caps requests at ~1/s — self-throttled at module level.
 */
const axios = require("axios");
const logger = require("../../config/logger");

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "AdsFlow/1.0 (contact: 89pavelmelnik@gmail.com)";
const MIN_INTERVAL_MS = 1100;

// A shared-timestamp check has a race under concurrent calls (two searches fired at once
// both read the same stale lastCallAt before either updates it, both then proceed
// immediately) — chaining through a single promise queue serializes throttle() calls so each
// one's wait is computed only after the previous call has fully finished.
let lastCallAt = 0;
let queue = Promise.resolve();
function throttle() {
  const turn = queue.then(async () => {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  queue = turn.catch(() => {});
  return turn;
}

/**
 * @param {string} regionText e.g. "Berlin", "Munich, Germany"
 * @returns {Promise<{ lat: number, lon: number, bbox: { south, west, north, east },
 *   polygon: GeoJSON.Polygon|GeoJSON.MultiPolygon|null }>}
 *
 * `bbox` is always a simple rectangle — for an irregularly-shaped region (a whole country, most
 * obviously) that rectangle's corners can land in a *different* country (Germany's bbox clips
 * bits of France/Switzerland/Austria at the edges). `polygon` is the region's real boundary
 * (simplified — polygon_threshold trades border precision most searches don't need for a
 * ~180x smaller payload than the full-detail shape) so callers can post-filter results to ones
 * actually inside the region instead of just inside its bounding rectangle.
 */
async function geocodeRegion(regionText) {
  await throttle();
  let resp;
  try {
    resp = await axios.get(NOMINATIM_URL, {
      params: { q: regionText, format: "json", limit: 1, polygon_geojson: 1, polygon_threshold: 0.01 },
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      timeout: 10000,
    });
  } catch (err) {
    logger.error("leadFinder.geocode: request failed", { regionText, error: err.message });
    throw new Error("Geocoding service unavailable, try again shortly");
  }

  const hit = resp.data?.[0];
  if (!hit || !hit.boundingbox) {
    throw new Error(`Region "${regionText}" not found`);
  }

  // Nominatim boundingbox = [south, north, west, east] as strings
  const [south, north, west, east] = hit.boundingbox.map(Number);
  const polygon = (hit.geojson?.type === "Polygon" || hit.geojson?.type === "MultiPolygon") ? hit.geojson : null;
  return {
    lat: Number(hit.lat),
    lon: Number(hit.lon),
    bbox: { south, west, north, east },
    polygon,
  };
}

module.exports = { geocodeRegion };
