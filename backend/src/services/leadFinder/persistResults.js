const { query } = require("../../db/pool");

/**
 * Bulk-inserts businesses into lead_results (deduped by workspace+osm_type+osm_id) and links
 * them all to this search via lead_search_results — one round trip each regardless of count,
 * instead of one query per business. ON CONFLICT is a harmless no-op update (not touching
 * search_id) purely so RETURNING still fires for a business seen in an earlier search — its
 * original search_id (and scrape state) stays put; lead_search_results is what links it to
 * THIS search too. Shared between the synchronous POST /search path and the tiled background
 * worker (see jobs/workers.js "lead-finder-search" queue).
 */
async function persistResults(searchId, workspaceId, businesses) {
  if (!businesses.length) return [];

  // An address OSM already publishes needs no scraping: it arrives as 'found', so the
  // scraper skips the row and add-to-contacts picks it up straight away. Rows without one
  // stay 'pending' and take the website route exactly as before. On a repeat sighting the
  // stored emails win — they may have come from a scrape that looked deeper than the tags.
  // Postgres has no ragged array-of-arrays, so the per-row email lists travel as array
  // literals in a plain text[] and are cast back one row at a time.
  const emailsLiteral = (b) => {
    const list = Array.isArray(b.emails) ? b.emails : [];
    if (!list.length) return "{}";
    return `{${list.map((e) => `"${String(e).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
  };
  const { rows } = await query(
    `INSERT INTO lead_results
       (search_id, workspace_id, osm_type, osm_id, name, category, address, lat, lon, website, phone,
        emails, scrape_status)
     SELECT $1, $2, u.osm_type, u.osm_id, u.name, u.category, u.address, u.lat, u.lon, u.website, u.phone,
            u.emails::text[],
            CASE WHEN COALESCE(array_length(u.emails::text[], 1), 0) > 0 THEN 'found' ELSE 'pending' END
     FROM UNNEST($3::text[], $4::bigint[], $5::text[], $6::text[], $7::text[], $8::float8[], $9::float8[], $10::text[], $11::text[], $12::text[])
       AS u(osm_type, osm_id, name, category, address, lat, lon, website, phone, emails)
     ON CONFLICT (workspace_id, osm_type, osm_id) DO UPDATE SET
       emails = CASE WHEN COALESCE(array_length(lead_results.emails, 1), 0) > 0
                     THEN lead_results.emails ELSE EXCLUDED.emails END,
       scrape_status = CASE WHEN COALESCE(array_length(lead_results.emails, 1), 0) = 0
                             AND COALESCE(array_length(EXCLUDED.emails, 1), 0) > 0
                            THEN 'found' ELSE lead_results.scrape_status END
     RETURNING *`,
    [
      searchId, workspaceId,
      businesses.map((b) => b.osm_type), businesses.map((b) => b.osm_id),
      businesses.map((b) => b.name), businesses.map((b) => b.category),
      businesses.map((b) => b.address), businesses.map((b) => b.lat),
      businesses.map((b) => b.lon), businesses.map((b) => b.website),
      businesses.map((b) => b.phone),
      businesses.map(emailsLiteral),
    ]
  );

  await query(
    `INSERT INTO lead_search_results (search_id, result_id)
     SELECT $1, id FROM UNNEST($2::uuid[]) AS t(id)
     ON CONFLICT DO NOTHING`,
    [searchId, rows.map((r) => r.id)]
  );

  return rows;
}

module.exports = { persistResults };
