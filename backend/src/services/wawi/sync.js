/**
 * JTL-Wawi → AdsFlow sync (READ-ONLY ingest). Pulls items, stock, all-channel
 * orders, customers, suppliers and reference data into the `wawi_*` tables, using
 * incremental cursors (changedSince / createdSince) where the API supports them.
 *
 * Nothing here writes to Amazon-derived tables. The ASIN bridge resolves
 * wawi_item_asins.product_id from `products` (read-only join key) but never mutates
 * `products`.
 */
const { query } = require("../../db/pool");
const logger = require("../../config/logger");
const { getConnection, wawiGet, wawiGetAll, wawiGetPagesParallel } = require("./client");

const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const ts = (v) => (v && !String(v).startsWith("0001-01-01") ? v : null);
const J = (v) => (v == null ? null : JSON.stringify(v));

/** Batched INSERT … ON CONFLICT DO UPDATE for a list of plain objects. */
async function bulkUpsert(table, columns, conflictCols, updateCols, rows, batch = 500) {
  // De-duplicate by the conflict key within this call — a single INSERT … ON CONFLICT
  // can't affect the same target row twice, and Wawi pages can repeat an Id.
  if (conflictCols.length && rows.length) {
    const seen = new Map();
    for (const r of rows) seen.set(conflictCols.map((c) => r[c]).join(""), r);
    rows = [...seen.values()];
  }
  let n = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    const vals = [];
    const tuples = slice.map((r) => {
      const ph = columns.map((c) => { vals.push(r[c] === undefined ? null : r[c]); return `$${vals.length}`; });
      return `(${ph.join(",")})`;
    });
    const setClause = updateCols.length
      ? `DO UPDATE SET ${updateCols.map((c) => `${c}=EXCLUDED.${c}`).join(", ")}`
      : "DO NOTHING";
    await query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")}
       ON CONFLICT (${conflictCols.join(",")}) ${setClause}`,
      vals
    );
    n += slice.length;
  }
  return n;
}

async function getCursor(workspaceId, entity) {
  const { rows } = await query(`SELECT cursor_value FROM wawi_sync_state WHERE workspace_id=$1 AND entity=$2`, [workspaceId, entity]);
  return rows[0]?.cursor_value || null;
}
async function setCursor(workspaceId, entity, cursor, status, rowsSynced, error = null) {
  await query(
    `INSERT INTO wawi_sync_state (workspace_id, entity, cursor_value, last_run_at, last_status, rows_synced, last_error)
     VALUES ($1,$2,$3,NOW(),$4,$5,$6)
     ON CONFLICT (workspace_id, entity) DO UPDATE SET
       cursor_value=COALESCE(EXCLUDED.cursor_value, wawi_sync_state.cursor_value),
       last_run_at=NOW(), last_status=EXCLUDED.last_status, rows_synced=EXCLUDED.rows_synced, last_error=EXCLUDED.last_error`,
    [workspaceId, entity, cursor, status, rowsSynced, error]
  );
}

// ─── Reference data ───────────────────────────────────────────────────────────
async function syncWarehouses(conn) {
  const ws = conn.workspace_id; const rows = [];
  await wawiGetAll(conn, "/warehouses", {}, (items) => {
    for (const w of items) rows.push({ workspace_id: ws, wawi_id: w.Id, name: w.Name || null, type: w.Type || null, raw_data: J(w) });
  });
  return bulkUpsert("wawi_warehouses", ["workspace_id","wawi_id","name","type","raw_data"], ["workspace_id","wawi_id"], ["name","type","raw_data","synced_at"], rows.map(r => ({ ...r, synced_at: undefined })));
}

async function syncSalesChannels(conn) {
  const ws = conn.workspace_id; const rows = [];
  await wawiGetAll(conn, "/salesChannels", {}, (items) => {
    for (const c of items) rows.push({ workspace_id: ws, wawi_id: c.Id, name: c.Name || c.PlatformName || null, type: c.Type || c.Platform || null, raw_data: J(c) });
  });
  return bulkUpsert("wawi_sales_channels", ["workspace_id","wawi_id","name","type","raw_data"], ["workspace_id","wawi_id"], ["name","type","raw_data"], rows);
}

async function syncSuppliers(conn) {
  const ws = conn.workspace_id; const rows = [];
  await wawiGetAll(conn, "/suppliers", {}, (items) => {
    for (const s of items) rows.push({ workspace_id: ws, wawi_id: s.Id, name: s.Name || s.CompanyName || null, raw_data: J(s) });
  });
  return bulkUpsert("wawi_suppliers", ["workspace_id","wawi_id","name","raw_data"], ["workspace_id","wawi_id"], ["name","raw_data"], rows);
}

// ─── Items (+ ASIN bridge) ────────────────────────────────────────────────────
function mapItem(ws, it) {
  const ids = it.Identifiers || {};
  const price = it.ItemPriceData || {};
  const asins = Array.isArray(ids.Asins) ? ids.Asins.filter(Boolean).map(String) : [];
  return {
    workspace_id: ws, wawi_id: it.Id, sku: it.SKU || null, name: it.Name || null,
    manufacturer_id: it.ManufacturerId ?? null, manufacturer_number: ids.ManufacturerNumber || null,
    is_active: it.IsActive ?? null, parent_item_id: it.ParentItemId ?? null,
    gtin: ids.Gtin || null, asins: J(asins), amazon_fnsku: ids.AmazonFnsku || null,
    sales_price_net: num(price.SalesPriceNet), suggested_retail: num(price.SuggestedRetailPrice),
    purchase_price_net: num(price.PurchasePriceNet), amazon_price: num(price.AmazonPrice),
    tax_class_id: it.TaxClassId ?? null, categories: J(it.Categories || null),
    dimensions: J(it.Dimensions || null), weights: J(it.Weights || null),
    active_sales_channels: J(it.ActiveSalesChannels || null),
    added_at: ts(it.Added), changed_at: ts(it.Changed), raw_data: J(it),
  };
}

async function syncItems(conn, { full = false } = {}) {
  const ws = conn.workspace_id;
  const cursor = full ? null : await getCursor(ws, "items");
  const params = cursor ? { changedSince: cursor } : {};
  let total = 0, maxChanged = cursor;
  const ITEM_COLS = ["workspace_id","wawi_id","sku","name","manufacturer_id","manufacturer_number","is_active","parent_item_id","gtin","asins","amazon_fnsku","sales_price_net","suggested_retail","purchase_price_net","amazon_price","tax_class_id","categories","dimensions","weights","active_sales_channels","added_at","changed_at","raw_data"];
  const UPD = ITEM_COLS.filter((c) => c !== "workspace_id" && c !== "wawi_id").concat("synced_at");

  // Item objects are heavy (Wawi serialises ~0.6 s/item) — small pages, long timeout,
  // and bounded parallelism so a 20k-item catalog loads in ~1 h instead of ~4 h.
  await wawiGetPagesParallel(conn, "/items", params, async (items) => {
    const mapped = items.map((it) => mapItem(ws, it));
    await bulkUpsert("wawi_items", ITEM_COLS, ["workspace_id","wawi_id"], UPD.filter(c => c !== "synced_at"), mapped);
    // ASIN bridge for this page
    const pairs = [];
    for (const it of items) {
      const asins = (it.Identifiers?.Asins || []).filter(Boolean).map(String);
      for (const a of asins) pairs.push({ workspace_id: ws, asin: a.toUpperCase(), wawi_item_id: it.Id });
    }
    if (pairs.length) await bulkUpsert("wawi_item_asins", ["workspace_id","asin","wawi_item_id"], ["workspace_id","asin","wawi_item_id"], [], pairs);
    for (const it of items) { const c = ts(it.Changed); if (c && (!maxChanged || c > maxChanged)) maxChanged = c; }
    total += items.length;
  }, { pageSize: 50, timeout: 90000, concurrency: 4 });

  // Resolve product_id for any unmatched ASIN bridge rows (read-only join to products).
  await query(
    `UPDATE wawi_item_asins w SET product_id = p.id, synced_at = NOW()
       FROM products p
      WHERE w.workspace_id = $1 AND p.workspace_id = $1
        AND UPPER(p.asin) = w.asin
        AND w.product_id IS DISTINCT FROM p.id`,
    [ws]
  );
  await setCursor(ws, "items", maxChanged, "ok", total);
  return total;
}

// ─── Stock + movements ────────────────────────────────────────────────────────
async function syncStocks(conn) {
  const ws = conn.workspace_id; let total = 0;
  const COLS = ["workspace_id","wawi_item_id","warehouse_id","storage_location_id","storage_location","quantity_total","qty_locked_shipment","qty_locked_avail","qty_in_picking","raw_data"];
  await wawiGetAll(conn, "/stocks", {}, async (items) => {
    const rows = items.map((s) => ({
      workspace_id: ws, wawi_item_id: s.ItemId, warehouse_id: s.WarehouseId, storage_location_id: s.StorageLocationId ?? 0,
      storage_location: s.StorageLocationName || null, quantity_total: num(s.QuantityTotal) ?? 0,
      qty_locked_shipment: num(s.QuantityLockedForShipment) ?? 0, qty_locked_avail: num(s.QuantityLockedForAvailability) ?? 0,
      qty_in_picking: num(s.QuantityInPickingLists) ?? 0, raw_data: J(s),
    }));
    total += await bulkUpsert("wawi_stocks", COLS, ["workspace_id","wawi_item_id","warehouse_id","storage_location_id"], ["storage_location","quantity_total","qty_locked_shipment","qty_locked_avail","qty_in_picking","raw_data","synced_at"].filter(c => c !== "synced_at"), rows);
  });
  await setCursor(ws, "stocks", null, "ok", total);
  return total;
}

async function syncStockChanges(conn, { sinceDays = 30 } = {}) {
  const ws = conn.workspace_id;
  const startDate = new Date(Date.now() - sinceDays * 86400000).toISOString();
  let total = 0;
  const COLS = ["workspace_id","wawi_item_id","warehouse_id","change_date","quantity","change_type","comment","raw_data"];
  await wawiGetAll(conn, "/stocks/changes", { startDate }, async (items) => {
    // Real /stocks/changes fields: ItemId, WarehouseId, Quantity, ChangedDate, Comment, Username.
    // change_type kept as "" (no type field exists) so the dedup unique key has no NULLs.
    const rows = items.map((c) => ({
      workspace_id: ws, wawi_item_id: c.ItemId ?? null, warehouse_id: c.WarehouseId ?? null,
      change_date: ts(c.ChangedDate || c.Date), quantity: num(c.Quantity),
      change_type: "", comment: c.Comment || null, raw_data: J(c),
    })).filter(r => r.wawi_item_id != null && r.change_date != null);
    if (rows.length) total += await bulkUpsert("wawi_stock_changes", COLS, ["workspace_id","wawi_item_id","change_date","quantity","change_type"], [], rows);
  });
  await setCursor(ws, "stock_changes", null, "ok", total);
  return total;
}

// ─── Sales orders (all channels) + line items ─────────────────────────────────
async function syncSalesOrders(conn, { full = false, initialLookbackDays = 180 } = {}) {
  const ws = conn.workspace_id;
  const cursor = full ? null : await getCursor(ws, "orders");
  const createdSince = cursor || new Date(Date.now() - initialLookbackDays * 86400000).toISOString();
  let total = 0, maxDate = cursor, lineTotal = 0;
  const O_COLS = ["workspace_id","wawi_id","number","external_number","company_id","customer_id","sales_channel_id","order_date","departure_country","payment_status","is_cancelled","is_external_invoice","raw_data"];
  const newOrderIds = [];

  await wawiGetAll(conn, "/salesOrders", { createdSince }, async (items) => {
    const rows = items.map((o) => {
      const d = ts(o.SalesOrderDate || o.CreationDate);
      if (d && (!maxDate || d > maxDate)) maxDate = d;
      newOrderIds.push(o.Id);
      return {
        workspace_id: ws, wawi_id: o.Id, number: o.Number || null, external_number: o.ExternalNumber || null,
        company_id: o.CompanyId ?? null, customer_id: o.CustomerId ?? null, sales_channel_id: o.SalesChannelId ?? null,
        order_date: d, departure_country: o.DepartureCountry || null,
        payment_status: o.SalesOrderPaymentDetails?.PaymentStatus || null,
        is_cancelled: !!o.IsCancelled, is_external_invoice: o.IsExternalInvoice ?? null, raw_data: J(o),
      };
    });
    total += await bulkUpsert("wawi_sales_orders", O_COLS, ["workspace_id","wawi_id"], O_COLS.filter(c => c !== "workspace_id" && c !== "wawi_id"), rows);
  });

  // Line items for the orders synced this run (per-order endpoint; non-fatal each).
  const LI_COLS = ["workspace_id","order_wawi_id","line_id","wawi_item_id","sku","name","quantity","unit_price_net","raw_data"];
  for (const oid of newOrderIds) {
    try {
      const li = await wawiGet(conn, `/salesOrders/${oid}/lineitems`);
      const arr = Array.isArray(li) ? li : (li?.Items || []);
      const rows = arr.map((l, idx) => ({
        workspace_id: ws, order_wawi_id: oid, line_id: l.Id ?? l.LineItemId ?? idx + 1,
        wawi_item_id: l.ItemId ?? null, sku: l.SKU || null, name: l.Name || null,
        quantity: num(l.Quantity), unit_price_net: num(l.SalesPriceNet), raw_data: J(l),
      }));
      if (rows.length) lineTotal += await bulkUpsert("wawi_sales_order_items", LI_COLS, ["workspace_id","order_wawi_id","line_id"], LI_COLS.filter(c => !["workspace_id","order_wawi_id","line_id"].includes(c)), rows);
    } catch (e) { logger.warn("Wawi line-items fetch failed (non-fatal)", { order: oid, error: e.message }); }
  }
  await setCursor(ws, "orders", maxDate, "ok", total);
  logger.info("Wawi orders synced", { orders: total, lineItems: lineTotal });
  return total;
}

// ─── Customers ────────────────────────────────────────────────────────────────
async function syncCustomers(conn, { full = false } = {}) {
  const ws = conn.workspace_id;
  const cursor = full ? null : await getCursor(ws, "customers");
  const params = cursor ? { lastChangeFrom: cursor } : {};
  let total = 0, maxChanged = cursor;
  const COLS = ["workspace_id","wawi_id","number","company","first_name","last_name","email","country","group_id","changed_at","raw_data"];
  await wawiGetAll(conn, "/customers", params, async (items) => {
    const rows = items.map((c) => {
      const ch = ts(c.LastChange || c.Changed);
      if (ch && (!maxChanged || ch > maxChanged)) maxChanged = ch;
      const a = c.BillingAddress || c.Address || {};
      return {
        workspace_id: ws, wawi_id: c.Id, number: c.Number || c.CustomerNumber || null,
        company: a.Company || c.Company || null, first_name: a.FirstName || null, last_name: a.LastName || null,
        email: a.EMail || a.Email || c.EMail || null, country: a.CountryIso || a.Country || null,
        group_id: c.CustomerGroupId ?? c.GroupId ?? null, changed_at: ch, raw_data: J(c),
      };
    });
    total += await bulkUpsert("wawi_customers", COLS, ["workspace_id","wawi_id"], COLS.filter(c => c !== "workspace_id" && c !== "wawi_id"), rows);
  });
  await setCursor(ws, "customers", maxChanged, "ok", total);
  return total;
}

/** Full orchestration for one workspace. `full` forces a from-scratch (no-cursor) pull. */
async function syncAll(workspaceId, { full = false } = {}) {
  const conn = await getConnection(workspaceId);
  if (!conn) throw new Error("No active Wawi connection for workspace");
  const out = {};
  // Items last: the /items endpoint is slow (~1 h full pull), so let the fast,
  // high-value entities (stock, orders, customers) land first instead of being
  // blocked behind it. ASIN matching still runs at the end of syncItems.
  const steps = [
    ["warehouses", () => syncWarehouses(conn)],
    ["salesChannels", () => syncSalesChannels(conn)],
    ["suppliers", () => syncSuppliers(conn)],
    ["stocks", () => syncStocks(conn)],
    ["stockChanges", () => syncStockChanges(conn, {})],
    ["orders", () => syncSalesOrders(conn, { full })],
    ["items", () => syncItems(conn, { full })],
    ["customers", () => syncCustomers(conn, { full })],  // largest + least-urgent → last
  ];
  for (const [name, fn] of steps) {
    try {
      out[name] = await fn();
      // Mark the step ok (cursor_value preserved via COALESCE) — clears any stale error
      // and gives steps without their own cursor (warehouses/channels/suppliers) a state.
      await setCursor(workspaceId, name, null, "ok", typeof out[name] === "number" ? out[name] : 0).catch(() => {});
    } catch (e) {
      out[name] = `error: ${e.message}`;
      logger.warn(`Wawi sync step failed: ${name}`, { error: e.message });
      await setCursor(workspaceId, name, null, "error", 0, e.message).catch(() => {});
    }
  }
  await query(`UPDATE wawi_connections SET last_sync_at = NOW(), updated_at = NOW() WHERE workspace_id = $1 AND status='active'`, [workspaceId]);
  logger.info("Wawi syncAll complete", { workspaceId, out });
  return out;
}

module.exports = { syncAll, syncWarehouses, syncSalesChannels, syncSuppliers, syncItems, syncStocks, syncStockChanges, syncSalesOrders, syncCustomers, bulkUpsert, mapItem };
