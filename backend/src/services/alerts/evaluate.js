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
const OPERATOR_LABELS = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=" };
const PERF_METRICS = ["acos", "roas", "spend", "sales", "orders", "clicks", "impressions", "ctr", "cpc", "cvr"];

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

// Account-level aggregate over the last `windowDays` days (campaign rows → no double count).
async function aggregateMetrics(workspaceId, windowDays) {
  const { rows: [agg] } = await query(
    `SELECT COALESCE(SUM(cost),0)        AS cost,
            COALESCE(SUM(sales_1d),0)    AS sales,
            COALESCE(SUM(orders_1d),0)   AS orders,
            COALESCE(SUM(clicks),0)      AS clicks,
            COALESCE(SUM(impressions),0) AS impressions
     FROM fact_metrics_daily
     WHERE workspace_id = $1 AND entity_type = 'campaign'
       AND date >= CURRENT_DATE - $2::int AND date <= CURRENT_DATE - 1`,
    [workspaceId, windowDays]
  );
  return agg;
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
      const r = await evaluateProductMovers(workspaceId, cfg, workspaceName);
      triggered += r.triggered; emailed += r.emailed;
      continue;
    }

    const cond = cfg.conditions || {};
    const metric = cond.metric;
    const operator = cond.operator;
    const threshold = Number(cond.value);
    const windowDays = Math.min(90, Math.max(1, parseInt(cond.window_days) || 7));

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

    const metricLabel = METRIC_LABELS[metric] || metric.toUpperCase();
    const opLabel = OPERATOR_LABELS[operator] || operator;
    const actualText = formatValue(metric, actual);
    const period = metric === "bsr" ? "latest snapshot" : `the last ${windowDays} days`;
    const title = `${metricLabel}${scopeLabel} ${opLabel} ${cond.value}`;
    const message = `${cfg.name}: ${metricLabel}${scopeLabel} is ${actualText} (threshold ${opLabel} ${cond.value}) over ${period}.`;
    const severity = ["acos", "bsr"].includes(metric) ? "high" : "medium";

    await query(
      `INSERT INTO alert_instances (config_id, workspace_id, severity, title, message, data)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [cfg.id, workspaceId, severity, title, message,
       JSON.stringify({ metric, operator, threshold, actual, windowDays, asin: cond.asin || null })]
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
            metricLabel: `${metricLabel}${scopeLabel}`, operatorLabel: opLabel,
            threshold: cond.value, actualText, windowDays: metric === "bsr" ? null : windowDays,
            periodText: period, dashboardUrl: process.env.FRONTEND_URL || null,
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

module.exports = { evaluateWorkspaceAlerts, evaluateProductMovers, computeMoverFlags, moverMetricValue, normalizeMoverConditions, moverWorstPct, partitionMovers, getRecentMoverHistory, PRODUCT_MOVER_METRICS, computeMetric, compare, formatValue, resolveRecipients, aggregateMetrics, latestBsr, amazonProductUrl, PERF_METRICS };
