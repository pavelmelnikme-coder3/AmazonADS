/**
 * Post-filters Overpass results against the region's real (simplified) polygon boundary —
 * needed because Nominatim's bbox is always a rectangle, and for an irregularly-shaped region
 * (any whole country, most visibly) that rectangle clips bits of neighboring countries at its
 * corners. Standard ray-casting point-in-polygon test; GeoJSON coordinates are [lon, lat].
 */
function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInGeometry(lat, lon, geometry) {
  const polygons = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  for (const poly of polygons) {
    // poly[0] = outer ring, poly[1..] = holes (exclaves within the shape don't count as inside)
    if (!pointInRing(lat, lon, poly[0])) continue;
    const inHole = poly.slice(1).some((hole) => pointInRing(lat, lon, hole));
    if (!inHole) return true;
  }
  return false;
}

/**
 * @param {Array<{lat, lon}>} businesses
 * @param {GeoJSON.Polygon|GeoJSON.MultiPolygon|null} polygon — null (no polygon available) fails
 *   open, keeping everything; a business with no lat/lon also fails open (can't verify, don't
 *   silently drop real data over a missing coordinate).
 */
function filterByPolygon(businesses, polygon) {
  if (!polygon) return businesses;
  return businesses.filter((b) => (b.lat == null || b.lon == null) || pointInGeometry(b.lat, b.lon, polygon));
}

module.exports = { filterByPolygon };
