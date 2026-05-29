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
const { sendAlertEmail } = require("../email");

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

module.exports = { evaluateWorkspaceAlerts, computeMetric, compare, formatValue, resolveRecipients, aggregateMetrics, latestBsr, PERF_METRICS };
