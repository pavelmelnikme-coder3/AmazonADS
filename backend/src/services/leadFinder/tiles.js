/**
 * Splits an oversized bbox (e.g. a whole country from Nominatim) into a grid of smaller tiles
 * so each one stays cheap enough for Overpass to finish within its own query timeout — a
 * broad-word regex tag-scan has no index to lean on, so cost scales with the area searched,
 * not just the match count.
 */
// Empirically, 1°x1° over a densely-tagged area (e.g. the Rhine valley near the French border)
// still hit Overpass's own timeout for a broad word ("restaurant") — every tile in that row
// failed. 0.5° reliably finished in ~8s for the same area and word; going smaller (0.3°) is
// even faster but roughly quadruples tile count for full coverage with little added safety
// margin, so 0.5° is the practical floor for "usually completes" without ballooning tile count.
const TILE_SIZE_DEG = 0.5;
// A real (if wide) single city can still exceed a narrow threshold — Hamburg's admin boundary
// alone spans ~2.2° east-west — so this only needs to catch genuinely country/state-scale
// regions, not just "a bit bigger than most cities".
const LARGE_BBOX_THRESHOLD_DEG = 2.5;
// Sanity ceiling on tile count: some countries' Nominatim bbox spans the *entire globe* because
// it includes far-flung overseas territories (France's bbox runs from South America to French
// Polynesia — observed 143,208 tiles at TILE_SIZE_DEG, an infeasible job). Past this, reject
// with a clear message instead of silently enqueueing something that would never finish.
const MAX_TILES = 1000;
// Shared between the synchronous search path (routes/leadFinder.js) and the tiled worker
// (jobs/workers.js) — a broad query over a whole city already matches thousands of OSM nodes;
// capping keeps a search a usable, focused list (scraping is 25/batch, so uncapped result sets
// would mean hundreds of scrape clicks either way).
const MAX_RESULTS_PER_SEARCH = 500;

function needsTiling(bbox) {
  const { south, north, west, east } = bbox;
  return (north - south) > LARGE_BBOX_THRESHOLD_DEG || (east - west) > LARGE_BBOX_THRESHOLD_DEG;
}

/**
 * Simple row-major grid over the bbox — no attempt to match the country's real shape. Tiles
 * that land outside it (sea, neighboring countries at the bbox's rectangular corners) just come
 * back with 0 matches quickly; that's cheap, not a correctness problem. Throws if the bbox is so
 * large (see MAX_TILES) that gridding it wouldn't be a feasible background job at all.
 */
function buildTileGrid(bbox, tileSizeDeg = TILE_SIZE_DEG) {
  const { south, north, west, east } = bbox;
  const estimatedCount = Math.ceil((north - south) / tileSizeDeg) * Math.ceil((east - west) / tileSizeDeg);
  if (estimatedCount > MAX_TILES) {
    throw new Error(
      "Region too large to search — it may span a huge or disconnected area (e.g. a country " +
      "with overseas territories). Try a more specific region (a state, region, or city)."
    );
  }
  const tiles = [];
  for (let s = south; s < north; s += tileSizeDeg) {
    const n = Math.min(s + tileSizeDeg, north);
    for (let w = west; w < east; w += tileSizeDeg) {
      const e = Math.min(w + tileSizeDeg, east);
      tiles.push({ south: s, west: w, north: n, east: e });
    }
  }
  return tiles;
}

module.exports = { needsTiling, buildTileGrid, TILE_SIZE_DEG, LARGE_BBOX_THRESHOLD_DEG, MAX_TILES, MAX_RESULTS_PER_SEARCH };
