/**
 * JTL-Wawi REST API client — STRICTLY READ-ONLY.
 *
 * Hard rule (see project memory `feedback-wawi-readonly`): this integration only
 * ever READS from Wawi. This client exposes GET-only helpers and refuses any other
 * method, so no code path can mutate the live ERP database.
 *
 * Auth headers for OnPremise requests:
 *   Authorization: Wawi <API-Key>
 *   x-appid: <AppId>   x-appversion: <Version>   api-version: <ver>   x-challengecode: <code>
 */
const axios = require("axios");
const { query } = require("../../db/pool");
const { decrypt } = require("../../config/encryption");
const logger = require("../../config/logger");

const DEFAULT_PAGE_SIZE = 250;

// Load the active Wawi connection for a workspace (with decrypted API key).
async function getConnection(workspaceId) {
  const { rows } = await query(
    `SELECT * FROM wawi_connections
      WHERE workspace_id = $1 AND status = 'active' AND api_key_enc IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [workspaceId]
  );
  if (!rows.length) return null;
  const conn = rows[0];
  try { conn.api_key = decrypt(conn.api_key_enc); } catch { conn.api_key = null; }
  return conn.api_key ? conn : null;
}

function authHeaders(conn) {
  return {
    Accept: "application/json",
    Authorization: `Wawi ${conn.api_key}`,
    "x-appid": conn.app_id,
    "x-appversion": conn.app_version,
    "api-version": conn.api_version,
    "x-challengecode": conn.challenge_code,
  };
}

/**
 * One authenticated GET. READ-ONLY — there is intentionally no post/put/patch/delete.
 * @returns {Promise<any>} parsed JSON body
 */
async function wawiGet(conn, path, params = {}, { timeout = 30000 } = {}) {
  const url = conn.base_url.replace(/\/$/, "") + "/" + String(path).replace(/^\//, "");
  const res = await axios.get(url, { headers: authHeaders(conn), params, timeout });
  return res.data;
}

/**
 * GET a JTL list endpoint across all pages. Handles both shapes:
 *   - paged object: { Items:[…], HasNextPage, NextPageNumber, TotalItems }
 *   - bare array:   [ … ]   (e.g. /companies, /warehouses, /salesChannels)
 * Calls `onPage(itemsArray, pageInfo)` for each page; returns the total count seen.
 */
async function wawiGetAll(conn, path, params = {}, onPage, { pageSize = DEFAULT_PAGE_SIZE, maxPages = 10000, timeout = 30000 } = {}) {
  let page = 1, total = 0;
  for (let i = 0; i < maxPages; i++) {
    const data = await wawiGet(conn, path, { ...params, pageNumber: page, pageSize }, { timeout });
    if (Array.isArray(data)) {                          // bare array → single page
      if (data.length) { await onPage(data, { pageNumber: page, hasNext: false }); total += data.length; }
      return total;
    }
    const items = Array.isArray(data?.Items) ? data.Items : [];
    if (items.length) { await onPage(items, { pageNumber: page, total: data.TotalItems }); total += items.length; }
    if (!data?.HasNextPage) return total;
    page = data.NextPageNumber || page + 1;
  }
  logger.warn("wawiGetAll: hit maxPages", { path, total });
  return total;
}

/**
 * Like wawiGetAll but fetches pages with bounded concurrency — for slow list endpoints
 * (the Wawi /items serializer is ~0.6 s/item, so serial paging of a big catalog is hours).
 * Page 1 is fetched first to learn TotalPages; the rest run in chunks of `concurrency`.
 * Order is not guaranteed (callers must be order-independent / idempotent).
 */
async function wawiGetPagesParallel(conn, path, params = {}, onPage, { pageSize = DEFAULT_PAGE_SIZE, timeout = 30000, concurrency = 4 } = {}) {
  const first = await wawiGet(conn, path, { ...params, pageNumber: 1, pageSize }, { timeout });
  if (Array.isArray(first)) { if (first.length) await onPage(first, { pageNumber: 1 }); return first.length; }
  const items1 = Array.isArray(first?.Items) ? first.Items : [];
  let total = items1.length;
  if (items1.length) await onPage(items1, { pageNumber: 1 });
  const totalPages = first?.TotalPages || 1;
  for (let p = 2; p <= totalPages; p += concurrency) {
    const batch = [];
    for (let k = 0; k < concurrency && p + k <= totalPages; k++) batch.push(p + k);
    const results = await Promise.all(batch.map((pn) =>
      wawiGet(conn, path, { ...params, pageNumber: pn, pageSize }, { timeout }).then((d) => ({ pn, d })).catch((e) => ({ pn, err: e }))));
    for (const r of results) {
      if (r.err) { logger.warn("wawi page failed", { path, page: r.pn, error: r.err.message }); continue; }
      const its = Array.isArray(r.d?.Items) ? r.d.Items : [];
      if (its.length) { await onPage(its, { pageNumber: r.pn }); total += its.length; }
    }
  }
  return total;
}

// Cheap reachability / identity probe (no auth needed for /info, but we send headers anyway).
async function wawiInfo(conn) {
  return wawiGet(conn, "/info", {}, { timeout: 10000 });
}

module.exports = { getConnection, wawiGet, wawiGetAll, wawiGetPagesParallel, wawiInfo, DEFAULT_PAGE_SIZE };
