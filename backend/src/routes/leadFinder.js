/**
 * Lead Finder — business prospecting tool, separate from Amazon Ads.
 *   POST   /search                       find businesses by region + free-text query (OSM)
 *   GET    /searches                     list past searches
 *   GET    /searches/:id/results         results for a search
 *   POST   /searches/:id/scrape          scrape emails from pending results' websites
 *   POST   /searches/:id/add-to-contacts promote found emails into email_contacts
 *
 * Results are scraped from public business websites — NOT opt-in contacts. They stay in
 * lead_results until explicitly promoted, and always land in email_contacts tagged and
 * marked with an honest consent_source ('scraped_public_website'), never claiming opt-in.
 */
const express = require("express");
const router = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const { geocodeRegion } = require("../services/leadFinder/geocode");
const { searchBusinesses } = require("../services/leadFinder/overpass");
const { fetchEmailsFromWebsite } = require("../services/leadFinder/emailScraper");
const { insertContacts } = require("../services/email/contacts");
const { persistResults } = require("../services/leadFinder/persistResults");
const { needsTiling, buildTileGrid, MAX_RESULTS_PER_SEARCH } = require("../services/leadFinder/tiles");
const { filterByPolygon } = require("../services/leadFinder/geofilter");

const SCRAPE_BATCH_SIZE = 25;
const SCRAPE_DELAY_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const slug = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

router.use(requireAuth, requireWorkspace);

// Kicks off the tiled background job for a region and responds 202/"running" — used both when
// the bbox is pre-detected as too large (needsTiling) and as a fallback when a same-shot
// synchronous attempt times out anyway (a wide-but-not-huge region, e.g. Hamburg's city-state
// boundary — 0.63°x2.22° — still 25s-timed-out once, even under the "obviously large" threshold;
// tiling doesn't need the bbox to be *country*-scale, just too much for one Overpass call).
async function startTiledSearch(req, res, region, businessQuery, bbox, polygon) {
  const tiles = buildTileGrid(bbox);
  const { rows: [search] } = await query(
    `INSERT INTO lead_searches
       (workspace_id, region_query, business_query, bbox, result_count, created_by, status, tiles_total, tiles_done)
     VALUES ($1,$2,$3,$4,0,$5,'running',$6,0)
     RETURNING id, region_query, business_query, bbox, result_count, created_at, status, tiles_total, tiles_done`,
    [req.workspaceId, region, businessQuery, JSON.stringify(bbox), req.user.id, tiles.length]
  );
  const { queueLeadFinderSearch } = require("../jobs/workers");
  const job = await queueLeadFinderSearch(search.id, req.workspaceId, tiles, businessQuery, polygon);
  await query(`UPDATE lead_searches SET job_id = $1 WHERE id = $2`, [String(job.id), search.id]);
  return res.status(202).json({ search, results: [], status: "running" });
}

// ─── Search ─────────────────────────────────────────────────────────────────
router.post("/search", async (req, res, next) => {
  try {
    const { region, query: businessQuery } = req.body;
    if (!region || !String(region).trim()) return res.status(400).json({ error: "region required" });
    if (!businessQuery || !String(businessQuery).trim()) return res.status(400).json({ error: "query required" });

    const { bbox, polygon } = await geocodeRegion(region);

    // A whole-country bbox is too large for one Overpass query (broad-word regex tag-scans
    // have no index to lean on — cost scales with area, not just match count). Those go to a
    // background job that tiles the bbox and processes it incrementally; anything city-sized
    // (today's common case) stays exactly as fast/synchronous as before.
    if (needsTiling(bbox)) {
      return await startTiledSearch(req, res, region, businessQuery, bbox, polygon);
    }

    let rawBusinesses;
    try {
      // Ask Overpass for one more than the cap so we can tell whether the true match set was
      // larger, without making it enumerate (and us transfer) every match for a broad query.
      rawBusinesses = await searchBusinesses({ bbox, query: businessQuery, limit: MAX_RESULTS_PER_SEARCH + 1 });
    } catch (err) {
      // The pre-check above is a heuristic, not a guarantee — a region can be under the
      // "obviously large" threshold and still be too much for one Overpass call. Rather than
      // fail the user outright, fall back to the same tiled job a bigger region would get.
      if (err.message?.includes("timed out")) {
        return await startTiledSearch(req, res, region, businessQuery, bbox, polygon);
      }
      throw err;
    }
    // Nominatim's bbox is a rectangle — for a region with an irregular border (a border city's
    // bbox can clip the neighboring country) that rectangle isn't the same as the real shape.
    const allBusinesses = filterByPolygon(rawBusinesses, polygon);
    const truncated = allBusinesses.length > MAX_RESULTS_PER_SEARCH;
    const businesses = truncated ? allBusinesses.slice(0, MAX_RESULTS_PER_SEARCH) : allBusinesses;

    const { rows: [search] } = await query(
      `INSERT INTO lead_searches (workspace_id, region_query, business_query, bbox, result_count, created_by, truncated)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, region_query, business_query, bbox, result_count, created_at`,
      [req.workspaceId, region, businessQuery, JSON.stringify(bbox), businesses.length, req.user.id, truncated]
    );

    const inserted = await persistResults(search.id, req.workspaceId, businesses);

    res.json({ search, results: inserted, total_matched: allBusinesses.length, truncated, status: "completed" });
  } catch (err) {
    if (err.message?.includes("not found") || err.message?.includes("busy") || err.message?.includes("unavailable") || err.message?.includes("timed out") || err.message?.includes("too large") || err.message === "query required") {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

router.get("/searches", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, region_query, business_query, result_count, created_at, status, tiles_total, tiles_done
       FROM lead_searches WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.workspaceId]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// Lightweight poll target for an in-progress (tiled, background) search.
router.get("/searches/:id", async (req, res, next) => {
  try {
    const { rows: [search] } = await query(
      `SELECT id, status, tiles_total, tiles_done, result_count, truncated, error_message
       FROM lead_searches WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.workspaceId]
    );
    if (!search) return res.status(404).json({ error: "Search not found" });
    res.json(search);
  } catch (err) { next(err); }
});

// Best-effort cancel — the worker checks this flag between tiles, so it takes effect after
// whichever tile is currently in flight finishes (BullMQ can't hard-interrupt a processor).
router.post("/searches/:id/cancel", async (req, res, next) => {
  try {
    const { rows: [search] } = await query(
      `UPDATE lead_searches SET cancel_requested = true
       WHERE id = $1 AND workspace_id = $2 AND status = 'running'
       RETURNING id, status`,
      [req.params.id, req.workspaceId]
    );
    if (!search) return res.status(404).json({ error: "Search not found or not running" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get("/searches/:id/results", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT lr.* FROM lead_results lr
       JOIN lead_search_results lsr ON lsr.result_id = lr.id
       WHERE lsr.search_id = $1 AND lr.workspace_id = $2
       ORDER BY lr.created_at ASC`,
      [req.params.id, req.workspaceId]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ─── Scrape ─────────────────────────────────────────────────────────────────
router.post("/searches/:id/scrape", async (req, res, next) => {
  try {
    const { resultIds } = req.body || {};
    const params = [req.params.id, req.workspaceId];
    let where = "lr.id IN (SELECT result_id FROM lead_search_results WHERE search_id = $1) " +
      "AND lr.workspace_id = $2 AND lr.scrape_status = 'pending' AND lr.website IS NOT NULL";
    if (Array.isArray(resultIds) && resultIds.length) {
      params.push(resultIds);
      where += ` AND lr.id = ANY($${params.length}::uuid[])`;
    }
    const { rows: pending } = await query(
      `SELECT lr.id, lr.website FROM lead_results lr WHERE ${where} ORDER BY lr.created_at ASC LIMIT ${SCRAPE_BATCH_SIZE}`,
      params
    );

    // Rows with no website at all are done immediately, never worth revisiting.
    await query(
      `UPDATE lead_results SET scrape_status = 'no_website', scraped_at = NOW()
       WHERE id IN (SELECT result_id FROM lead_search_results WHERE search_id = $1)
         AND workspace_id = $2 AND scrape_status = 'pending' AND website IS NULL`,
      [req.params.id, req.workspaceId]
    );

    let found = 0, noEmail = 0, errors = 0;
    for (let i = 0; i < pending.length; i++) {
      const row = pending[i];
      const { status, emails } = await fetchEmailsFromWebsite(row.website);
      await query(
        `UPDATE lead_results SET emails = $1, scrape_status = $2, scraped_at = NOW() WHERE id = $3`,
        [emails, status, row.id]
      );
      if (status === "found") found++;
      else if (status === "no_email") noEmail++;
      else errors++;

      if (i < pending.length - 1) await sleep(SCRAPE_DELAY_MS);
    }

    const { rows: [{ count: remainingPending }] } = await query(
      `SELECT COUNT(*)::int AS count FROM lead_results
       WHERE id IN (SELECT result_id FROM lead_search_results WHERE search_id = $1)
         AND workspace_id = $2 AND scrape_status = 'pending'`,
      [req.params.id, req.workspaceId]
    );

    res.json({ attempted: pending.length, found, no_email: noEmail, errors, remaining_pending: remainingPending });
  } catch (err) { next(err); }
});

// ─── Add to contacts ───────────────────────────────────────────────────────
router.post("/searches/:id/add-to-contacts", async (req, res, next) => {
  try {
    const { rows: [search] } = await query(
      `SELECT region_query, business_query FROM lead_searches WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.workspaceId]
    );
    if (!search) return res.status(404).json({ error: "Search not found" });

    const tag = req.body?.tag?.trim() || `lead:${slug(search.region_query)}-${slug(search.business_query)}`;

    const { rows: candidates } = await query(
      `SELECT id, name, emails FROM lead_results
       WHERE id IN (SELECT result_id FROM lead_search_results WHERE search_id = $1)
         AND workspace_id = $2 AND added_to_contacts = false AND array_length(emails, 1) > 0`,
      [req.params.id, req.workspaceId]
    );

    const alreadyAdded = await query(
      `SELECT COUNT(*)::int AS count FROM lead_results
       WHERE id IN (SELECT result_id FROM lead_search_results WHERE search_id = $1)
         AND workspace_id = $2 AND added_to_contacts = true`,
      [req.params.id, req.workspaceId]
    );

    let added = 0, skipped = 0;
    for (const c of candidates) {
      const contacts = c.emails.map((email) => ({ email, first_name: c.name, tags: [tag] }));
      const result = await insertContacts(req.workspaceId, contacts, "scraped_public_website", "lead_finder", req.ip);
      added += result.imported;
      skipped += result.skipped + result.invalid;
      await query(`UPDATE lead_results SET added_to_contacts = true WHERE id = $1`, [c.id]);
    }

    res.json({ added, skipped_no_email: skipped, already_added: alreadyAdded.rows[0].count, tag });
  } catch (err) { next(err); }
});

module.exports = router;
