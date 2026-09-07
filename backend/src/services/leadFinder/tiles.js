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

/**
 * Reorder tiles so consecutive visits land far apart on the grid.
 *
 * buildTileGrid walks rows south→north, and the worker stops once the result budget is spent,
 * so a first-come budget buys "the southern edge of the region" while the search still reports
 * itself as covering the whole region. Live case: the 2026-07-15 "restaurants in Germany" run
 * stopped after 24 of 304 tiles and every one of its 500 results sat between 47.34°N and
 * 48.20°N — the Alpine strip — for a country spanning 47.3°N to 55.1°N. The list read as a
 * national sample and was actually the Allgäu.
 *
 * Walking with a stride coprime to the tile count visits every tile exactly once while
 * spreading early visits across the whole grid, so a budget that runs out still buys a
 * region-wide sample. Deterministic, unlike a shuffle: the same search reorders the same way.
 */
function spreadTileOrder(tiles) {
  const n = tiles.length;
  if (n < 4) return tiles.slice();
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  // Start near sqrt(n) so the stride is large enough to jump between grid rows but small
  // enough that early visits still fan out rather than repeatedly wrapping the same way.
  let step = Math.max(2, Math.round(Math.sqrt(n)));
  while (step < n && gcd(step, n) !== 1) step++;
  if (step >= n) return tiles.slice(); // no coprime stride available (n prime-adjacent edge)
  const out = [];
  for (let i = 0, idx = 0; i < n; i++, idx = (idx + step) % n) out.push(tiles[idx]);
  return out;
}

// Per-tile share of the result budget. Without it the first tiles visited spend the whole
// budget, which is the same geographic-bias bug spreadTileOrder addresses, one level down:
// a single dense city tile can hold more restaurants than the entire cap.
// The floor keeps sparse rural tiles from being rounded down to nothing useful.
const MIN_RESULTS_PER_TILE = 3;

function perTileCap(tileCount, totalCap = MAX_RESULTS_PER_SEARCH) {
  if (tileCount <= 1) return totalCap;
  return Math.max(MIN_RESULTS_PER_TILE, Math.ceil(totalCap / tileCount));
}

module.exports = {
  needsTiling, buildTileGrid, spreadTileOrder, perTileCap,
  TILE_SIZE_DEG, LARGE_BBOX_THRESHOLD_DEG, MAX_TILES, MAX_RESULTS_PER_SEARCH, MIN_RESULTS_PER_TILE,
};
