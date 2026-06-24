/**
 * Alert evaluation engine.
 *
 * For each active alert_config, computes the configured metric and compares it to
 * the threshold. Two metric families:
 *   • performance (acos/roas/spend/sales/orders/clicks/impressions/ctr/cpc/cvr) —
 *     account-level aggregate from fact_metrics_daily (campaign rows, configurable
 *     rolling window in days).
 *   • bsr — latest Best-Sellers Rank for a specific ASIN from bsr_snapshots.
 * On breach (and outside the suppression_hours cooldown) it writes an alert_instance
 * and fires channels (in-app = the instance; email = sendAlertEmail).
 */
const { query } = require("../../db/pool");
const logger = require("../../config/logger");
const { sendAlertEmail, sendProductMoversEmail } = require("../email");

const METRIC_LABELS = {
  acos: "ACOS", roas: "ROAS", spend: "Spend", sales: "Sales", orders: "Orders",
  clicks: "Clicks", impressions: "Impressions", ctr: "CTR", cpc: "CPC", cvr: "CVR",
  bsr: "BSR",
};
const OPERATOR_LABELS = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=", drop_pct: "↓%", rise_pct: "↑%" };
const PERF_METRICS = ["acos", "roas", "spend", "sales", "orders", "clicks", "impressions", "ctr", "cpc", "cvr"];
// Percentage-change operators: compare the current window to the preceding window of
// the same length and fire on a drop/rise of ≥ threshold %. Perf metrics only (BSR
// uses a point-in-time snapshot, not a window aggregate, so a window-over-window % is
// not meaningful for it).
const CHANGE_OPERATORS = new Set(["drop_pct", "rise_pct"]);

const ACOS_NO_SALES = 9999; // spend with zero sales → effectively infinite ACOS, finite for comparison/formatting

function computeMetric(metric, agg) {
  const cost = Number(agg.cost) || 0;
  const sales = Number(agg.sales) || 0;
  const orders = Number(agg.orders) || 0;
  const clicks = Number(agg.clicks) || 0;
  const impressions = Number(agg.impressions) || 0;
  switch (metric) {
    case "acos":        return sales > 0 ? (cost / sales) * 100 : (cost > 0 ? ACOS_NO_SALES : 0);
    case "roas":        return cost > 0 ? sales / cost : 0;
    case "spend":       return cost;
    case "sales":       return sales;
    case "orders":      return orders;
    case "clicks":      return clicks;
    case "impressions": return impressions;
    case "ctr":         return impressions > 0 ? (clicks / impressions) * 100 : 0;
    case "cpc":         return clicks > 0 ? cost / clicks : 0;
    case "cvr":         return clicks > 0 ? (orders / clicks) * 100 : 0;
    default:            return null;
  }
}

function compare(actual, operator, threshold) {
  switch (operator) {
    case "gt":  return actual >  threshold;
    case "gte": return actual >= threshold;
    case "lt":  return actual <  threshold;
    case "lte": return actual <= threshold;
    case "eq":  return actual === threshold;
    default:    return false;
  }
}

function formatValue(metric, v) {
  if (v == null || Number.isNaN(v)) return "—";
  switch (metric) {
    case "acos": return v >= ACOS_NO_SALES ? "∞ (no sales)" : `${v.toFixed(1)}%`;
    case "ctr":
    case "cvr":  return `${v.toFixed(2)}%`;
    case "roas": return `${v.toFixed(2)}×`;
    case "spend":
    case "sales":
    case "cpc":  return `€${v.toFixed(2)}`;
    case "bsr":  return `#${Math.round(v).toLocaleString()}`;
    case "orders":
    case "clicks":
    case "impressions": return Math.round(v).toLocaleString();
    default: return String(v);
  }
}

async function resolveRecipients(workspaceId, emailTo) {
  if (emailTo && String(emailTo).trim()) {
    return String(emailTo)
      .split(/[,;\s]+/).map((s) => s.trim())
      .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
  }
  const { rows } = await query(
    `SELECT u.email FROM workspace_members wm JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = $1 AND wm.role IN ('owner','admin') AND u.email IS NOT NULL`,
    [workspaceId]
  );
  return rows.map((r) => r.email);
}

// Account-level aggregate over the day range [CURRENT_DATE - fromOffset, CURRENT_DATE - toOffset]
// (campaign rows → no double count). Inclusive on both ends.
async function aggregateMetricsRange(workspaceId, fromOffset, toOffset) {
  const { rows: [agg] } = await query(
    `SELECT COALESCE(SUM(cost),0)        AS cost,
            COALESCE(SUM(sales_1d),0)    AS sales,
            COALESCE(SUM(orders_1d),0)   AS orders,
            COALESCE(SUM(clicks),0)      AS clicks,
            COALESCE(SUM(impressions),0) AS impressions
     FROM fact_metrics_daily
     WHERE workspace_id = $1 AND entity_type = 'campaign'
       AND date >= CURRENT_DATE - $2::int AND date <= CURRENT_DATE - $3::int`,
    [workspaceId, fromOffset, toOffset]
  );
  return agg;
}

// Last `windowDays` days (current window): [today-windowDays, yesterday].
function aggregateMetrics(workspaceId, windowDays) {
  return aggregateMetricsRange(workspaceId, windowDays, 1);
}

async function latestBsr(workspaceId, asin) {
  const { rows: [r] } = await query(
    `SELECT bs.best_rank FROM bsr_snapshots bs
     JOIN products p ON p.id = bs.product_id
     WHERE p.workspace_id = $1 AND UPPER(p.asin) = $2
     ORDER BY bs.captured_at DESC LIMIT 1`,
    [workspaceId, asin]
  );
  return r?.best_rank != null ? Number(r.best_rank) : null;
}

// Amazon marketplace id → storefront domain (for /dp/ links in emails).
const MARKETPLACE_DOMAINS = {
  ATVPDKIKX0DER: "amazon.com", A2EUQ1WTGCTBG2: "amazon.ca", A1AM78C64UM0Y8: "amazon.com.mx",
  A2Q3Y263D00KWC: "amazon.com.br", A1PA6795UKMFR9: "amazon.de", A1RKKUPIHCS9HS: "amazon.es",
  A13V1IB3VIYZZH: "amazon.fr", APJ6JRA9NG5V4: "amazon.it", A1F83G8C2ARO7P: "amazon.co.uk",
  A1805IZSGTT6HS: "amazon.nl", A2NODRKZP88ZB9: "amazon.se", A1C3SOZRARQ6R3: "amazon.pl",
  AMEN7PMS3EDWL: "amazon.com.be", A1805IZSGTT6HS_dummy: "", A1VC38T7YXB528: "amazon.co.jp",
  A21TJRUUN4KGV: "amazon.in", A39IBJ37TRP1C6: "amazon.com.au", A33AVAJ2PDY3EV: "amazon.com.tr",
  A2VIGQ35RCS4UG: "amazon.ae", A17E79C6D8DWNP: "amazon.sa",
};
function amazonProductUrl(asin, marketplaceId) {
  const domain = MARKETPLACE_DOMAINS[marketplaceId] || "amazon.de";
  return `https://www.${domain}/dp/${asin}`;
}

// Per-product metrics available to the "product movers" alert.
//   source: bsr   = median best_rank (bsr_snapshots)
//           total = total (organic + ad) per ASIN from SP-API orders (sp_order_items)
//           ad    = ad-attributed per ASIN from advertised_product sums
//   dir   = the default "worse" direction the UI uses when the metric is added.
const PRODUCT_MOVER_METRICS = {
  bsr:         { label: "BSR",         source: "bsr",   fmt: "rank",  dir: "up"   },
  orders:      { label: "Orders",      source: "total", fmt: "int",   dir: "down" }, // total order count (SP-API)
  units:       { label: "Units",       source: "total", fmt: "int",   dir: "down" }, // total units ordered (SP-API)
  sales:       { label: "Sales",       source: "total", fmt: "money", dir: "down" }, // total ordered product sales (SP-API)
  spend:       { label: "Spend",       source: "ad",    fmt: "money", dir: "up"   },
  clicks:      { label: "Clicks",      source: "ad",    fmt: "int",   dir: "down" },
  impressions: { label: "Impressions", source: "ad",    fmt: "int",   dir: "down" },
  acos:        { label: "ACOS",        source: "ad",    fmt: "pct",   dir: "up"   },
  ctr:         { label: "CTR",         source: "ad",    fmt: "pct",   dir: "down" },
  cpc:         { label: "CPC",         source: "ad",    fmt: "money", dir: "up"   },
  cvr:         { label: "CVR",         source: "ad",    fmt: "pct",   dir: "down" },
  roas:        { label: "ROAS",        source: "ad",    fmt: "x",     dir: "down" },
  ad_orders:   { label: "Ad orders",   source: "ad",    fmt: "int",   dir: "down" }, // ad-attributed orders
  ad_sales:    { label: "Ad sales",    source: "ad",    fmt: "money", dir: "down" }, // ad-attributed sales
};
const ACOS_NO_SALES_MOVER = 9999;

// Value of `metric` from a window aggregate. `w` carries:
//   bsr · ordersTotal/unitsTotal/salesTotal (SP) · cost/adSales/adOrders/clicks/impressions (ad)
function moverMetricValue(metric, w) {
  if (!w) return null;
  switch (metric) {
    case "bsr":         return w.bsr;
    case "orders":      return w.ordersTotal;
    case "units":       return w.unitsTotal;
    case "sales":       return w.salesTotal;
    case "ad_orders":   return w.adOrders;
    case "ad_sales":    return w.adSales;
    case "spend":       return w.cost;
    case "clicks":      return w.clicks;
    case "impressions": return w.impressions;
    case "acos":        return w.adSales > 0 ? (w.cost / w.adSales) * 100 : (w.cost > 0 ? ACOS_NO_SALES_MOVER : null);
    case "ctr":         return w.impressions > 0 ? (w.clicks / w.impressions) * 100 : null;
    case "cpc":         return w.clicks > 0 ? w.cost / w.clicks : null;
    case "cvr":         return w.clicks > 0 ? (w.adOrders / w.clicks) * 100 : null;
    case "roas":        return w.cost > 0 ? w.adSales / w.cost : null;
    default:            return null;
  }
}

// The prior-window order count used as the noise floor for a metric of `source`.
function moverGateValue(source, w) {
  if (source === "total") return w.ordersTotal;
  if (source === "ad")    return w.adOrders;
  return Infinity; // bsr — never gated
}

// Normalise conditions into { metrics:[{metric,direction,change_pct}], match }.
// Back-compat: synthesises the list from the legacy { bsr_change_pct, orders_change_pct, require_both } shape.
function normalizeMoverConditions(cond) {
  let metrics = Array.isArray(cond.metrics) ? cond.metrics : null;
  let match = cond.match === "all" ? "all" : "any";
  if (!metrics) {
    metrics = [];
    if (Number(cond.bsr_change_pct) > 0)    metrics.push({ metric: "bsr",    direction: "up",   change_pct: Number(cond.bsr_change_pct) });
    if (Number(cond.orders_change_pct) > 0) metrics.push({ metric: "orders", direction: "down", change_pct: Number(cond.orders_change_pct) });
    if (cond.require_both) match = "all";
  }
  metrics = metrics
    .filter((m) => m && PRODUCT_MOVER_METRICS[m.metric] && Number(m.change_pct) > 0)
    .map((m) => ({ metric: m.metric, direction: m.direction === "up" ? "up" : "down", change_pct: Number(m.change_pct) }));
  if (metrics.length < 2) match = "any"; // "all" only meaningful with ≥2 conditions
  return { metrics, match };
}

// Severity scalar for a flagged product: magnitude of its worst single-metric move.
function moverWorstPct(metricsArr) {
  return Math.max(0, ...(metricsArr || []).map((m) => Math.abs(Number(m.pct) || 0)));
}

/**
 * Split freshly-flagged products into fresh / escalated / suppressed using prior-alert
 * history, to cut repeat noise. A product already alerted within `cooldownDays` is
 * SUPPRESSED unless its worst move grew by ≥ `escalationPct` points since that alert
 * (then it re-surfaces as "escalated"). When the cooldown has elapsed it is "new" again.
 * Pure — no I/O. `historyMap`: UPPER(asin) → { lastAt:number(ms), worstPct:number }.
 * @returns {{fresh:Array, escalated:Array, suppressed:Array}}
 */
function partitionMovers(flagged, historyMap, { cooldownDays = 0, escalationPct = 0, now = Date.now() } = {}) {
  const fresh = [], escalated = [], suppressed = [];
  const cooldownMs = Math.max(0, cooldownDays) * 86400000;
  const hist = historyMap instanceof Map ? historyMap : new Map();
  for (const p of (flagged || [])) {
    const asin = String(p.asin || "").toUpperCase();
    const h = cooldownMs > 0 ? hist.get(asin) : null;
    const within = h && (now - h.lastAt) < cooldownMs;
    if (!within) { fresh.push({ ...p, status: "new" }); continue; }
    const curWorst = moverWorstPct(p.metrics);
    const worsened = escalationPct > 0 && curWorst >= h.worstPct + escalationPct;
    if (worsened) escalated.push({ ...p, status: "escalated", prev_worst_pct: Math.round(h.worstPct) });
    else suppressed.push({ ...p, status: "suppressed" });
  }
  return { fresh, escalated, suppressed };
}

// Most-recent prior product-movers alert per ASIN for one config, within `sinceDays`.
async function getRecentMoverHistory(configId, sinceDays) {
  if (!configId || !(sinceDays > 0)) return new Map();
  const { rows } = await query(
    `SELECT created_at, data FROM alert_instances
      WHERE config_id = $1 AND entity_type = 'product_movers'
        AND created_at >= NOW() - make_interval(days => $2::int)
      ORDER BY created_at DESC`,
    [configId, Math.ceil(sinceDays)]
  );
  const map = new Map();
  for (const r of rows) {
    const at = new Date(r.created_at).getTime();
    const data = typeof r.data === "string" ? JSON.parse(r.data) : (r.data || {});
    for (const p of (data.products || [])) {
      const asin = String(p.asin || "").toUpperCase();
      if (!asin || map.has(asin)) continue; // rows newest-first → first seen = most recent
      map.set(asin, { lastAt: at, worstPct: moverWorstPct(p.metrics) });
    }
  }
  return map;
}

/**
 * Pure computation for the product-movers alert (no side effects — used by the live
 * evaluator and by tests). Scans ALL active products and flags those that breach the
 * metric conditions, comparing a rolling N-day window against the preceding N-day window.
 * @returns {Promise<{flagged:Array, metrics:Array, match:string, N:number, severity:string, title:string, message:string}>}
 */
async function computeMoverFlags(workspaceId, cond, cfgName = "") {
  const N = Math.min(90, Math.max(1, parseInt(cond.window_days) || 7));
  const minOrdersPrev = Number(cond.min_orders_prev) || 0;
  const { metrics, match } = normalizeMoverConditions(cond);
  if (!metrics.length) return { flagged: [], metrics, match, N, severity: "medium", title: "", message: "" };
  const sources = new Set(metrics.map((m) => PRODUCT_MOVER_METRICS[m.metric].source));

  // Product anchor + BSR medians (current vs previous window). LEFT JOIN so products
  // without snapshots still surface (they may breach on ad / total metrics alone).
  const { rows: prodRows } = await query(
    `SELECT p.id, p.asin, p.title, p.image_url, p.marketplace_id, p.brand,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY bs.best_rank)
         FILTER (WHERE bs.captured_at::date >= CURRENT_DATE - $2::int AND bs.captured_at::date <= CURRENT_DATE - 1) AS bsr_cur,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY bs.best_rank)
         FILTER (WHERE bs.captured_at::date >= CURRENT_DATE - $3::int AND bs.captured_at::date <= CURRENT_DATE - $2::int - 1) AS bsr_prev,
       (array_agg(bs.best_category ORDER BY bs.captured_at DESC) FILTER (WHERE bs.best_category IS NOT NULL))[1] AS best_category
     FROM products p
     LEFT JOIN bsr_snapshots bs
       ON bs.product_id = p.id
      AND bs.captured_at::date >= CURRENT_DATE - $3::int AND bs.captured_at::date <= CURRENT_DATE - 1
      AND bs.best_rank IS NOT NULL
     WHERE p.workspace_id = $1 AND p.is_active = true
     GROUP BY p.id`,
    [workspaceId, N, 2 * N]
  );

  // Ad sums per ASIN for both windows (only when an ad metric is requested).
  const adByAsin = new Map();
  if (sources.has("ad")) {
    const curF = `FILTER (WHERE f.date >= CURRENT_DATE - $2::int AND f.date <= CURRENT_DATE - 1)`;
    const prevF = `FILTER (WHERE f.date >= CURRENT_DATE - $3::int AND f.date <= CURRENT_DATE - $2::int - 1)`;
    const { rows: adRows } = await query(
      `SELECT UPPER(f.amazon_id) AS asin,
         COALESCE(SUM(f.cost)        ${curF},0)  AS cost_cur,   COALESCE(SUM(f.cost)        ${prevF},0)  AS cost_prev,
         COALESCE(SUM(f.sales_1d)    ${curF},0)  AS sales_cur,  COALESCE(SUM(f.sales_1d)    ${prevF},0)  AS sales_prev,
         COALESCE(SUM(f.orders_1d)   ${curF},0)  AS ord_cur,    COALESCE(SUM(f.orders_1d)   ${prevF},0)  AS ord_prev,
         COALESCE(SUM(f.clicks)      ${curF},0)  AS clk_cur,    COALESCE(SUM(f.clicks)      ${prevF},0)  AS clk_prev,
         COALESCE(SUM(f.impressions) ${curF},0)  AS imp_cur,    COALESCE(SUM(f.impressions) ${prevF},0)  AS imp_prev
       FROM fact_metrics_daily f
       WHERE f.workspace_id = $1 AND f.entity_type = 'advertised_product'
         AND f.date >= CURRENT_DATE - $3::int AND f.date <= CURRENT_DATE - 1
       GROUP BY UPPER(f.amazon_id)`,
      [workspaceId, N, 2 * N]
    );
    for (const r of adRows) adByAsin.set(r.asin, r);
  }

  // Total (organic + ad) orders/units/sales per ASIN from SP-API orders (only when needed).
  const totByAsin = new Map();
  if (sources.has("total")) {
    const curF = `FILTER (WHERE o.purchase_date::date >= CURRENT_DATE - $2::int AND o.purchase_date::date <= CURRENT_DATE - 1)`;
    const prevF = `FILTER (WHERE o.purchase_date::date >= CURRENT_DATE - $3::int AND o.purchase_date::date <= CURRENT_DATE - $2::int - 1)`;
    const { rows: totRows } = await query(
      `SELECT UPPER(oi.asin) AS asin,
         COUNT(DISTINCT o.id) ${curF}  AS ord_cur,   COUNT(DISTINCT o.id) ${prevF}  AS ord_prev,
         COALESCE(SUM(oi.quantity_ordered)  ${curF},0) AS units_cur,  COALESCE(SUM(oi.quantity_ordered)  ${prevF},0) AS units_prev,
         COALESCE(SUM(oi.item_price_amount) ${curF},0) AS sales_cur,  COALESCE(SUM(oi.item_price_amount) ${prevF},0) AS sales_prev
       FROM sp_order_items oi
       JOIN sp_orders o ON o.id = oi.order_id
       WHERE oi.workspace_id = $1 AND o.order_status <> 'Canceled'
         AND o.purchase_date::date >= CURRENT_DATE - $3::int AND o.purchase_date::date <= CURRENT_DATE - 1
         AND oi.asin IS NOT NULL
       GROUP BY UPPER(oi.asin)`,
      [workspaceId, N, 2 * N]
    );
    for (const r of totRows) totByAsin.set(r.asin, r);
  }

  const flagged = [];
  for (const p of prodRows) {
    const asin = String(p.asin || "").toUpperCase();
    const ad = adByAsin.get(asin);
    const tot = totByAsin.get(asin);
    const win = (suffix) => ({
      bsr: p[`bsr_${suffix}`] != null ? Number(p[`bsr_${suffix}`]) : null,
      cost: ad ? Number(ad[`cost_${suffix}`]) : 0, adSales: ad ? Number(ad[`sales_${suffix}`]) : 0,
      adOrders: ad ? Number(ad[`ord_${suffix}`]) : 0, clicks: ad ? Number(ad[`clk_${suffix}`]) : 0,
      impressions: ad ? Number(ad[`imp_${suffix}`]) : 0,
      ordersTotal: tot ? Number(tot[`ord_${suffix}`]) : 0, unitsTotal: tot ? Number(tot[`units_${suffix}`]) : 0,
      salesTotal: tot ? Number(tot[`sales_${suffix}`]) : 0,
    });
    const cur = win("cur");
    const prev = win("prev");

    const breached = [];
    for (const c of metrics) {
      const meta = PRODUCT_MOVER_METRICS[c.metric];
      // Noise floor: order-derived metrics need enough prior-period orders to be trustworthy.
      if (minOrdersPrev > 0 && moverGateValue(meta.source, prev) < minOrdersPrev) continue;
      const pv = moverMetricValue(c.metric, prev);
      const cv = moverMetricValue(c.metric, cur);
      if (pv == null || cv == null || !(pv > 0)) continue; // can't compute a %
      const pct = ((cv - pv) / pv) * 100;
      const breach = c.direction === "up" ? pct >= c.change_pct : pct <= -c.change_pct;
      // Clamp displayed % so a sentinel (∞ ACOS) or tiny denominator can't show absurd numbers.
      const pctShown = Math.max(-9999, Math.min(9999, Math.round(pct)));
      if (breach) breached.push({ metric: c.metric, label: meta.label, fmt: meta.fmt, direction: c.direction, prev: pv, cur: cv, pct: pctShown });
    }

    const flag = match === "all" ? breached.length === metrics.length : breached.length > 0;
    if (!flag) continue;

    flagged.push({
      asin: p.asin, title: p.title, image_url: p.image_url, brand: p.brand,
      best_category: p.best_category, url: amazonProductUrl(p.asin, p.marketplace_id),
      metrics: breached,
    });
  }

  // Worst movers first (largest single-metric % move).
  const worst = (f) => Math.max(0, ...f.metrics.map((m) => Math.abs(m.pct)));
  flagged.sort((a, b) => worst(b) - worst(a));

  const severity = flagged.some((f) => f.metrics.some((m) => Math.abs(m.pct) >= 75)) ? "high" : "medium";
  const title = `${flagged.length} product${flagged.length > 1 ? "s" : ""} moved beyond thresholds`;
  const summary = flagged.slice(0, 25)
    .map((f) => `${f.asin}: ${f.metrics.map((m) => `${m.label} ${m.pct >= 0 ? "+" : ""}${m.pct}%`).join(", ")}`).join(" | ");
  const message = `${cfgName ? cfgName + ": " : ""}${flagged.length} product(s) breached over the last ${N} days vs the prior ${N} days. ${summary}`;
  return { flagged, metrics, match, N, severity, title, message };
}

/**
 * Enrich flagged movers with REAL, data-derived likely causes (instead of only the
 * static checklist). Mutates each product, setting `p.causes = [{type, severity, detail, pct?, value?}]`.
 * Detectable from synced data:
 *   • stock_out / stock_low — Wawi ERP stock (`wawi_stocks` via `wawi_item_asins`) +
 *     FBA sellable (`sp_inventory`). FBA stock lives at Amazon, ERP stock in Wawi — so
 *     both sources are surfaced explicitly (ERP: x · FBA: y) and we never invent an
 *     out-of-stock from a single missing source.
 *   • price_up — order-derived avg selling price, current N-day window vs prior.
 *   • ad_cut  — ad spend (`fact_metrics_daily`), current window vs prior.
 * Buy-Box / reviews / listing-suppression / market are NOT synced → left to the static checklist.
 * Best-effort: each query is independently guarded; a failure just yields fewer causes.
 */
async function detectMoverCauses(workspaceId, products, N, opts = {}) {
  if (!products || !products.length) return;
  const asins = [...new Set(products.map((p) => String(p.asin || "").toUpperCase()).filter(Boolean))];
  if (!asins.length) return;

  // Tunable thresholds (config-driven; sane defaults).
  const pricePct = Number.isFinite(Number(opts.pricePct)) ? Math.max(0, Number(opts.pricePct)) : 5;   // price rise %
  const adPct    = Number.isFinite(Number(opts.adPct))    ? Math.max(0, Number(opts.adPct))    : 50;  // ad-spend drop %
  const lowStock = Number.isFinite(Number(opts.lowStock)) ? Math.max(0, Number(opts.lowStock)) : 10;  // low-stock units

  const wawiStock = new Map(); // asin → erp qty (null = unknown: not mapped OR no stock row)
  const fbaStock  = new Map(); // asin → sellable (null = no SP inventory data)
  const priceWin  = new Map(); // asin → { cur, prev }
  const adWin     = new Map(); // asin → { cur, prev }

  try {
    // wawi_stocks only ever holds positive-quantity rows (the Wawi /stocks feed omits
    // zero-stock locations, and the sync upserts without writing zeros). So a mapped item
    // with NO stock row means "absent from the positive-stock feed" — NOT a confirmed zero.
    // COUNT the joined rows to tell a real reported quantity apart from missing data; when
    // there are no rows ERP stays unknown (null) rather than a synthesised 0.
    const { rows } = await query(
      `SELECT UPPER(ia.asin) AS asin, SUM(ws.quantity_total) AS stock,
              COUNT(ws.wawi_item_id) AS nrows
         FROM wawi_item_asins ia
         LEFT JOIN wawi_stocks ws
           ON ws.workspace_id = ia.workspace_id AND ws.wawi_item_id = ia.wawi_item_id
        WHERE ia.workspace_id = $1 AND UPPER(ia.asin) = ANY($2::text[])
        GROUP BY UPPER(ia.asin)`,
      [workspaceId, asins]
    );
    for (const r of rows) wawiStock.set(r.asin, Number(r.nrows) > 0 ? Number(r.stock) : null);
  } catch (e) { logger.warn("detectMoverCauses: wawi stock query failed", { error: e.message }); }

  try {
    const { rows } = await query(
      `SELECT UPPER(asin) AS asin, SUM(quantity_sellable) AS sellable, COUNT(quantity_sellable) AS nn
         FROM sp_inventory
        WHERE workspace_id = $1 AND UPPER(asin) = ANY($2::text[])
        GROUP BY UPPER(asin)`,
      [workspaceId, asins]
    );
    for (const r of rows) fbaStock.set(r.asin, Number(r.nn) > 0 ? Number(r.sellable) : null);
  } catch (e) { logger.warn("detectMoverCauses: fba stock query failed", { error: e.message }); }

  try {
    // Only priced lines count toward avg unit price. Pending orders carry a quantity but a
    // NULL item_price_amount; left in, they inflate the denominator and deflate the average
    // (e.g. one €20.99 unit + two unpriced pending units → 20.99/3 ≈ €7.00, a phantom drop).
    const curF  = `FILTER (WHERE oi.item_price_amount IS NOT NULL AND o.purchase_date::date >= CURRENT_DATE - $3::int AND o.purchase_date::date <= CURRENT_DATE - 1)`;
    const prevF = `FILTER (WHERE oi.item_price_amount IS NOT NULL AND o.purchase_date::date >= CURRENT_DATE - $4::int AND o.purchase_date::date <= CURRENT_DATE - $3::int - 1)`;
    const { rows } = await query(
      `SELECT UPPER(oi.asin) AS asin,
         SUM(oi.item_price_amount) ${curF}  / NULLIF(SUM(oi.quantity_ordered) ${curF}, 0)  AS price_cur,
         SUM(oi.item_price_amount) ${prevF} / NULLIF(SUM(oi.quantity_ordered) ${prevF}, 0) AS price_prev
       FROM sp_order_items oi JOIN sp_orders o ON o.id = oi.order_id
       WHERE oi.workspace_id = $1 AND o.order_status <> 'Canceled'
         AND UPPER(oi.asin) = ANY($2::text[])
         AND o.purchase_date::date >= CURRENT_DATE - $4::int AND o.purchase_date::date <= CURRENT_DATE - 1
       GROUP BY UPPER(oi.asin)`,
      [workspaceId, asins, N, 2 * N]
    );
    for (const r of rows) priceWin.set(r.asin, { cur: r.price_cur != null ? Number(r.price_cur) : null, prev: r.price_prev != null ? Number(r.price_prev) : null });
  } catch (e) { logger.warn("detectMoverCauses: price query failed", { error: e.message }); }

  try {
    const curF  = `FILTER (WHERE f.date >= CURRENT_DATE - $3::int AND f.date <= CURRENT_DATE - 1)`;
    const prevF = `FILTER (WHERE f.date >= CURRENT_DATE - $4::int AND f.date <= CURRENT_DATE - $3::int - 1)`;
    const { rows } = await query(
      `SELECT UPPER(f.amazon_id) AS asin,
         COALESCE(SUM(f.cost) ${curF}, 0)  AS cost_cur,
         COALESCE(SUM(f.cost) ${prevF}, 0) AS cost_prev
       FROM fact_metrics_daily f
       WHERE f.workspace_id = $1 AND f.entity_type = 'advertised_product'
         AND UPPER(f.amazon_id) = ANY($2::text[])
         AND f.date >= CURRENT_DATE - $4::int AND f.date <= CURRENT_DATE - 1
       GROUP BY UPPER(f.amazon_id)`,
      [workspaceId, asins, N, 2 * N]
    );
    for (const r of rows) adWin.set(r.asin, { cur: Number(r.cost_cur), prev: Number(r.cost_prev) });
  } catch (e) { logger.warn("detectMoverCauses: ad spend query failed", { error: e.message }); }

  // Demand-side causes (price hike, ad pullback) only plausibly explain declines in
  // VOLUME or RANK. They must NOT be shown for efficiency RATIOS where they contradict
  // the move — e.g. cutting ad spend RAISES ROAS and LOWERS ACOS, so "ad cut" can never
  // be the cause of a ROAS drop / ACOS rise. We only attach such a cause when at least
  // one of the product's breached metrics is one the cause can actually drive.
  // (Stock causes are exempt — no inventory collapses every metric, ratios included.)
  const PRICE_UP_EXPLAINS = new Set(["bsr", "orders", "units", "sales", "ad_orders", "ad_sales", "cvr"]);
  const AD_CUT_EXPLAINS   = new Set(["bsr", "orders", "units", "sales", "ad_orders", "ad_sales", "clicks", "impressions", "spend"]);

  for (const p of products) {
    const asin = String(p.asin || "").toUpperCase();
    const causes = [];
    const breached = new Set((p.metrics || []).map((m) => m.metric));
    const explains = (set) => [...breached].some((m) => set.has(m));

    // Stock — surface both sources explicitly; flag only on genuinely-known values.
    // Availability = the MAX across known sources, not the min: a product is in stock if
    // ANY channel has units (e.g. ERP 100 / FBA 0 = sold via merchant, NOT out of stock).
    // When no source is known we emit no cause rather than inventing "out of stock".
    // Confidence in an empty signal depends on how many sources confirm it:
    //   • BOTH sources known & 0 → stock_out (high, "out of stock") — empty everywhere we see.
    //   • only ONE source known & 0 → a softer channel-specific signal (fba_empty / erp_empty,
    //     medium): that channel is empty but the other is unknown, so the product may still
    //     sell via the unknown channel (e.g. FBM) — don't overstate "out of stock".
    const erp = wawiStock.has(asin) ? wawiStock.get(asin) : null;
    const fba = fbaStock.has(asin) ? fbaStock.get(asin) : null;
    const known = [erp, fba].filter((v) => v != null);
    if (known.length) {
      const detail = `ERP: ${erp != null ? erp : "n/a"} · FBA: ${fba != null ? fba : "n/a"}`;
      const avail = Math.max(...known);
      if (avail > 0) {
        if (avail <= lowStock) causes.push({ type: "stock_low", severity: "medium", detail, value: avail });
      } else if (known.length >= 2) {
        causes.push({ type: "stock_out", severity: "high", detail });          // empty in every known channel
      } else if (fba != null) {
        causes.push({ type: "fba_empty", severity: "medium", detail });        // only FBA known & empty
      } else {
        causes.push({ type: "erp_empty", severity: "medium", detail });        // only ERP known & empty
      }
    }

    // Price hike — only when it rose ≥ pricePct% AND it can explain a breached metric.
    const pr = priceWin.get(asin);
    if (pr && pr.prev > 0 && pr.cur != null && explains(PRICE_UP_EXPLAINS)) {
      const chg = ((pr.cur - pr.prev) / pr.prev) * 100;
      if (chg > 0 && chg >= pricePct) causes.push({ type: "price_up", severity: "medium", pct: Math.round(chg), detail: `€${pr.prev.toFixed(2)} → €${pr.cur.toFixed(2)}` });
    }

    // Ad pullback — spend down ≥ adPct% AND it can explain a breached metric (never for
    // a pure efficiency-ratio drop like ROAS, where less spend would IMPROVE the metric).
    const ad = adWin.get(asin);
    if (ad && ad.prev > 0 && explains(AD_CUT_EXPLAINS)) {
      const chg = ((ad.cur - ad.prev) / ad.prev) * 100;
      if (chg < 0 && chg <= -adPct) causes.push({ type: "ad_cut", severity: "medium", pct: Math.round(chg), detail: `€${ad.prev.toFixed(2)} → €${ad.cur.toFixed(2)}` });
    }

    causes.sort((a, b) => (b.severity === "high" ? 1 : 0) - (a.severity === "high" ? 1 : 0));
    p.causes = causes;
  }
}

/**
 * Live product-movers evaluator: cooldown gate → compute → single in-app instance +
 * single digest email listing every breached product.
 * @returns {Promise<{triggered:number, emailed:number}>}
 */
async function evaluateProductMovers(workspaceId, cfg, workspaceName) {
  const cond = cfg.conditions || {};
  const { metrics } = normalizeMoverConditions(cond);
  if (!metrics.length) return { triggered: 0, emailed: 0 };

  // Per-config cooldown (one digest per suppression window).
  if (cfg.last_triggered_at) {
    const ageMs = Date.now() - new Date(cfg.last_triggered_at).getTime();
    if (ageMs < (cfg.suppression_hours || 24) * 3600 * 1000) return { triggered: 0, emailed: 0 };
  }

  const { flagged, match, N } = await computeMoverFlags(workspaceId, cond, cfg.name);
  if (!flagged.length) return { triggered: 0, emailed: 0 };

  // Per-product dedup (C): suppress products already alerted within the cooldown unless
  // they worsened by ≥ escalation_pct points; split the rest into new / escalated (D).
  const cooldownDays  = cond.product_cooldown_days != null ? Math.max(0, Number(cond.product_cooldown_days)) : 7;
  const escalationPct = cond.escalation_pct       != null ? Math.max(0, Number(cond.escalation_pct))       : 25;
  let notified = flagged.map((p) => ({ ...p, status: "new" }));
  let suppressedCount = 0;
  if (cooldownDays > 0) {
    const history = await getRecentMoverHistory(cfg.id, cooldownDays);
    const part = partitionMovers(flagged, history, { cooldownDays, escalationPct });
    notified = [...part.fresh, ...part.escalated];
    suppressedCount = part.suppressed.length;
    if (!notified.length) return { triggered: 0, emailed: 0, suppressed: suppressedCount }; // all repeats → stay quiet
  }

  // Enrich with real, data-derived causes (stock / price / ads) — best-effort.
  try {
    await detectMoverCauses(workspaceId, notified, N, {
      pricePct: cond.cause_price_pct, adPct: cond.cause_ad_pct, lowStock: cond.cause_low_stock,
    });
  } catch (e) { logger.warn("detectMoverCauses failed (non-fatal)", { config: cfg.id, error: e.message }); }

  // Worst movers first; titles/severity reflect the NOTIFIED subset, not the raw flagged set.
  notified.sort((a, b) => moverWorstPct(b.metrics) - moverWorstPct(a.metrics));
  const freshCount = notified.filter((p) => p.status !== "escalated").length;
  const escalatedCount = notified.length - freshCount;
  const severity = notified.some((f) => f.metrics.some((m) => Math.abs(m.pct) >= 75)) ? "high" : "medium";
  const title = `${notified.length} product${notified.length > 1 ? "s" : ""} moved beyond thresholds`;
  const summary = notified.slice(0, 25)
    .map((f) => `${f.asin}: ${f.metrics.map((m) => `${m.label} ${m.pct >= 0 ? "+" : ""}${m.pct}%`).join(", ")}`).join(" | ");
  const message = `${cfg.name ? cfg.name + ": " : ""}${notified.length} product(s) breached over the last ${N} days vs the prior ${N} days${suppressedCount ? ` (+${suppressedCount} continuing, suppressed)` : ""}. ${summary}`;

  await query(
    `INSERT INTO alert_instances (config_id, workspace_id, severity, title, message, entity_type, entity_name, data)
     VALUES ($1,$2,$3,$4,$5,'product_movers',$6,$7)`,
    [cfg.id, workspaceId, severity, title, message, `${notified.length} products`,
     JSON.stringify({ window_days: N, match, metrics, products: notified,
       suppressed_count: suppressedCount, fresh_count: freshCount, escalated_count: escalatedCount,
       cooldown_days: cooldownDays, escalation_pct: escalationPct })]
  );
  await query(`UPDATE alert_configs SET last_triggered_at = NOW() WHERE id = $1`, [cfg.id]);

  let emailed = 0;
  const ch = cfg.channels || {};
  if (ch.email) {
    const recipients = await resolveRecipients(workspaceId, ch.email_to);
    if (recipients.length) {
      try {
        await sendProductMoversEmail({
          to: recipients, alertName: cfg.name, workspaceName, windowDays: N,
          products: notified, suppressedCount, dashboardUrl: process.env.FRONTEND_URL || null,
        });
        emailed = 1;
      } catch (e) {
        logger.warn("Product-movers email failed (non-fatal)", { config: cfg.id, error: e.message });
      }
    }
  }
  return { triggered: 1, emailed };
}

/**
 * Top campaigns by ad spend over the current window, with the change vs the prior
 * equal-length window. Surfaced on spend ("overspend") alerts so the driver of the
 * spend is visible right in the notification (the alert itself is account-level).
 * Ordered by current spend desc (where the budget is going); delta shows what ramped.
 */
async function topSpendCampaigns(workspaceId, windowDays, limit = 6) {
  const CUR  = `FILTER (WHERE f.date >= CURRENT_DATE - $2::int AND f.date <= CURRENT_DATE - 1)`;
  const PREV = `FILTER (WHERE f.date >= CURRENT_DATE - 2*$2::int AND f.date <= CURRENT_DATE - $2::int - 1)`;
  const { rows } = await query(
    `SELECT COALESCE(c.name, f.entity_id::text) AS name, c.campaign_type,
            COALESCE(SUM(f.cost)      ${CUR}, 0) AS spend,
            COALESCE(SUM(f.cost)      ${PREV},0) AS prev_spend,
            COALESCE(SUM(f.sales_1d)  ${CUR}, 0) AS sales,
            COALESCE(SUM(f.orders_1d) ${CUR}, 0) AS orders,
            COALESCE(SUM(f.clicks)    ${CUR}, 0) AS clicks
       FROM fact_metrics_daily f
       LEFT JOIN campaigns c ON c.id = f.entity_id AND c.workspace_id = f.workspace_id
      WHERE f.workspace_id = $1 AND f.entity_type = 'campaign'
        AND f.date >= CURRENT_DATE - 2*$2::int AND f.date <= CURRENT_DATE - 1
      GROUP BY 1, 2
      HAVING COALESCE(SUM(f.cost) ${CUR}, 0) > 0
      ORDER BY spend DESC
      LIMIT $3`,
    [workspaceId, windowDays, limit]
  );
  const r2 = (v) => Math.round(v * 100) / 100;
  return rows.map((r) => {
    const spend = Number(r.spend), prev = Number(r.prev_spend);
    const sales = Number(r.sales), orders = Number(r.orders), clicks = Number(r.clicks);
    return {
      name: r.name, campaign_type: r.campaign_type || null,
      spend: r2(spend), prev_spend: r2(prev),
      delta: r2(spend - prev),
      delta_pct: prev > 0 ? Math.round(((spend - prev) / prev) * 100) : null,
      // Health snapshot over the current window.
      sales: r2(sales), orders,
      roas: spend > 0 ? r2(sales / spend) : null,            // sales per €1 ad spend
      acos: sales > 0 ? Math.round((spend / sales) * 1000) / 10 : (spend > 0 ? null : null), // %
    };
  });
}

/**
 * Evaluate all active alerts for a workspace.
 * @returns {Promise<{evaluated:number, triggered:number, emailed:number}>}
 */
async function evaluateWorkspaceAlerts(workspaceId, { workspaceName = null } = {}) {
  const { rows: configs } = await query(
    `SELECT * FROM alert_configs WHERE workspace_id = $1 AND is_active = true`,
    [workspaceId]
  );
  if (!configs.length) return { evaluated: 0, triggered: 0, emailed: 0 };

  const aggCache = new Map(); // windowDays → agg row (avoid re-querying same window)
  let triggered = 0, emailed = 0;

  for (const cfg of configs) {
    // Per-product BSR/orders movers — its own evaluation + digest email path.
    if (cfg.alert_type === "product_movers") {
      try {
        const r = await evaluateProductMovers(workspaceId, cfg, workspaceName);
        triggered += r.triggered; emailed += r.emailed;
      } catch (e) {
        logger.warn("Product-movers evaluation failed (non-fatal)", { config: cfg.id, error: e.message });
      }
      continue;
    }

    const cond = cfg.conditions || {};
    const metric = cond.metric;
    const operator = cond.operator;
    const threshold = Number(cond.value);
    const windowDays = Math.min(90, Math.max(1, parseInt(cond.window_days) || 7));
    const metricLabel = METRIC_LABELS[metric] || (metric ? metric.toUpperCase() : "");
    const isChange = CHANGE_OPERATORS.has(operator);

    // Per-alert display + payload, built differently for absolute vs change operators.
    let title, message, severity, dataObj, emailParams;

    if (isChange) {
      // Window-over-window percentage change — perf metrics only.
      if (!PERF_METRICS.includes(metric)) continue;
      const prevKey = `prev:${windowDays}`;
      if (!aggCache.has(windowDays)) aggCache.set(windowDays, await aggregateMetrics(workspaceId, windowDays));
      if (!aggCache.has(prevKey)) aggCache.set(prevKey, await aggregateMetricsRange(workspaceId, 2 * windowDays, windowDays + 1));
      const cur = computeMetric(metric, aggCache.get(windowDays));
      const prev = computeMetric(metric, aggCache.get(prevKey));
      // Need a positive prior value to express a meaningful % change.
      if (cur == null || prev == null || Number.isNaN(cur) || Number.isNaN(prev) || !(prev > 0)) continue;
      const pct = ((cur - prev) / prev) * 100;
      const breach = operator === "drop_pct" ? pct <= -threshold : pct >= threshold;
      if (!breach) continue;
      // Cooldown
      if (cfg.last_triggered_at) {
        const ageMs = Date.now() - new Date(cfg.last_triggered_at).getTime();
        if (ageMs < (cfg.suppression_hours || 24) * 3600 * 1000) continue;
      }
      const dirWord = operator === "drop_pct" ? "dropped" : "rose";
      const pctAbs = Math.abs(Math.round(pct));
      const prevText = formatValue(metric, prev);
      const curText = formatValue(metric, cur);
      title = `${metricLabel} ${dirWord} ${pctAbs}% (${windowDays}d)`;
      message = `${cfg.name}: ${metricLabel} ${dirWord} ${pctAbs}% over the last ${windowDays} days (${prevText} → ${curText}) vs the prior ${windowDays} days. Threshold: ${dirWord} ≥ ${threshold}%.`;
      severity = pctAbs >= 50 ? "high" : "medium";
      dataObj = { metric, operator, threshold, change_pct: Math.round(pct), prev, cur, windowDays };
      emailParams = {
        metricLabel: `${metricLabel} change`, operatorLabel: `${dirWord} ≥`, threshold: `${threshold}%`,
        actualText: `${pct < 0 ? "−" : "+"}${pctAbs}% (${prevText} → ${curText})`,
        windowDays, periodText: `the last ${windowDays} days vs the prior ${windowDays} days`,
      };
    } else {
      // Absolute threshold.
      let actual = null;
      let scopeLabel = "";
      if (metric === "bsr") {
        const asin = String(cond.asin || "").trim().toUpperCase();
        if (!asin) continue;
        actual = await latestBsr(workspaceId, asin);
        scopeLabel = ` for ${asin}`;
      } else if (PERF_METRICS.includes(metric)) {
        if (!aggCache.has(windowDays)) aggCache.set(windowDays, await aggregateMetrics(workspaceId, windowDays));
        actual = computeMetric(metric, aggCache.get(windowDays));
      } else {
        continue; // unknown metric
      }

      if (actual == null || Number.isNaN(actual)) continue;
      if (!compare(actual, operator, threshold)) continue;

      // Cooldown
      if (cfg.last_triggered_at) {
        const ageMs = Date.now() - new Date(cfg.last_triggered_at).getTime();
        if (ageMs < (cfg.suppression_hours || 24) * 3600 * 1000) continue;
      }

      const opLabel = OPERATOR_LABELS[operator] || operator;
      const actualText = formatValue(metric, actual);
      const period = metric === "bsr" ? "latest snapshot" : `the last ${windowDays} days`;
      title = `${metricLabel}${scopeLabel} ${opLabel} ${cond.value}`;
      message = `${cfg.name}: ${metricLabel}${scopeLabel} is ${actualText} (threshold ${opLabel} ${cond.value}) over ${period}.`;
      severity = ["acos", "bsr"].includes(metric) ? "high" : "medium";
      dataObj = { metric, operator, threshold, actual, windowDays, asin: cond.asin || null };
      emailParams = {
        metricLabel: `${metricLabel}${scopeLabel}`, operatorLabel: opLabel,
        threshold: cond.value, actualText, windowDays: metric === "bsr" ? null : windowDays, periodText: period,
      };
    }

    // Spend ("overspend") alerts: attach the per-campaign breakdown so the driver of
    // the spend is visible in the instance + email (the threshold itself is account-wide).
    if (metric === "spend") {
      try {
        const top = await topSpendCampaigns(workspaceId, windowDays, 6);
        if (top.length) { dataObj.top_campaigns = top; emailParams.topCampaigns = top; }
      } catch (e) { logger.warn("topSpendCampaigns failed (non-fatal)", { config: cfg.id, error: e.message }); }
    }

    await query(
      `INSERT INTO alert_instances (config_id, workspace_id, severity, title, message, data)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [cfg.id, workspaceId, severity, title, message, JSON.stringify(dataObj)]
    );
    await query(`UPDATE alert_configs SET last_triggered_at = NOW() WHERE id = $1`, [cfg.id]);
    triggered++;

    const ch = cfg.channels || {};
    if (ch.email) {
      const recipients = await resolveRecipients(workspaceId, ch.email_to);
      if (recipients.length) {
        try {
          await sendAlertEmail({
            to: recipients, alertName: cfg.name, workspaceName,
            ...emailParams, dashboardUrl: process.env.FRONTEND_URL || null,
          });
          emailed++;
        } catch (e) {
          logger.warn("Alert email failed (non-fatal)", { config: cfg.id, error: e.message });
        }
      }
    }
  }
  return { evaluated: configs.length, triggered, emailed };
}

module.exports = { evaluateWorkspaceAlerts, evaluateProductMovers, computeMoverFlags, detectMoverCauses, moverMetricValue, normalizeMoverConditions, moverWorstPct, partitionMovers, getRecentMoverHistory, PRODUCT_MOVER_METRICS, computeMetric, compare, formatValue, resolveRecipients, aggregateMetrics, aggregateMetricsRange, topSpendCampaigns, latestBsr, amazonProductUrl, PERF_METRICS, CHANGE_OPERATORS };
