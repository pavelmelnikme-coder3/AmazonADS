const express = require("express");
const router = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const { queueMetricsBackfill } = require("../jobs/workers");
const logger = require("../config/logger");

router.use(requireAuth, requireWorkspace);

// GET /metrics/summary?startDate=&endDate=&groupBy=campaign_type
router.get("/summary", async (req, res, next) => {
  try {
    const { startDate, endDate, groupBy, campaignType } = req.query;
    const start = startDate || new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const end = endDate || new Date().toISOString().split("T")[0];

    const conditions = ["workspace_id = $1", "date BETWEEN $2 AND $3"];
    const params = [req.workspaceId, start, end];
    let pi = 4;

    if (campaignType) {
      conditions.push(`campaign_type = $${pi++}`);
      params.push(campaignType);
    }

    const where = conditions.join(" AND ");

    const { rows: [totals] } = await query(
      `SELECT
         SUM(impressions) as impressions,
         SUM(clicks) as clicks,
         SUM(cost) as spend,
         SUM(sales_14d) as sales,
         SUM(orders_14d) as orders,
         CASE WHEN SUM(impressions)>0 THEN SUM(clicks)::numeric/SUM(impressions)*100 END as ctr,
         CASE WHEN SUM(clicks)>0 THEN SUM(cost)/SUM(clicks) END as cpc,
         CASE WHEN SUM(sales_14d)>0 THEN SUM(cost)/SUM(sales_14d)*100 END as acos,
         CASE WHEN SUM(cost)>0 THEN SUM(sales_14d)/SUM(cost) END as roas
       FROM fact_metrics_daily
       WHERE ${where} AND entity_type = 'campaign'`,
      params
    );

    // Daily trend
    const { rows: trend } = await query(
      `SELECT date,
         SUM(impressions) as impressions,
         SUM(clicks) as clicks,
         SUM(cost) as spend,
         SUM(sales_14d) as sales,
         SUM(orders_14d) as orders,
         CASE WHEN SUM(impressions)>0 THEN SUM(clicks)::numeric/SUM(impressions)*100 ELSE 0 END as ctr,
         CASE WHEN SUM(clicks)>0 THEN SUM(cost)/SUM(clicks) ELSE 0 END as cpc,
         CASE WHEN SUM(sales_14d)>0 THEN SUM(cost)/SUM(sales_14d)*100 ELSE 0 END as acos,
         CASE WHEN SUM(cost)>0 THEN SUM(sales_14d)/SUM(cost) ELSE 0 END as roas
       FROM fact_metrics_daily
       WHERE ${where} AND entity_type = 'campaign'
       GROUP BY date ORDER BY date`,
      params
    );

    // Previous period for delta calculation
    const prevStart = new Date(start);
    const prevEnd = new Date(end);
    const range = (new Date(end) - new Date(start));
    prevStart.setTime(prevStart.getTime() - range - 86400000);
    prevEnd.setTime(prevEnd.getTime() - range - 86400000);

    const { rows: [prev] } = await query(
      `SELECT SUM(cost) as spend, SUM(sales_14d) as sales,
              CASE WHEN SUM(sales_14d)>0 THEN SUM(cost)/SUM(sales_14d)*100 END as acos,
              CASE WHEN SUM(cost)>0 THEN SUM(sales_14d)/SUM(cost) END as roas
       FROM fact_metrics_daily
       WHERE workspace_id = $1 AND date BETWEEN $2 AND $3 AND entity_type = 'campaign'`,
      [req.workspaceId, prevStart.toISOString().split("T")[0], prevEnd.toISOString().split("T")[0]]
    );

    // TACoS: try SP-API orders first, fall back to ad-attributed sales (sales_14d)
    let tacos = null;
    let totalRevenue = null;
    let tacosSource = null; // 'sp_api' | 'ads_attributed'
    try {
      const { rows: [spTotals] } = await query(
        `SELECT SUM(order_total_amount) AS total_revenue FROM sp_orders
         WHERE workspace_id = $1 AND purchase_date BETWEEN $2 AND $3
         AND order_status NOT IN ('Canceled', 'Unfulfillable')`,
        [req.workspaceId, start, end]
      );
      if (spTotals?.total_revenue) {
        totalRevenue = parseFloat(spTotals.total_revenue);
        const spend = parseFloat(totals?.spend || 0);
        if (totalRevenue > 0 && spend > 0) {
          tacos = (spend / totalRevenue * 100).toFixed(2);
          tacosSource = 'sp_api';
        }
      }
    } catch {}

    // Fallback: use ad-attributed sales_14d as denominator when SP-API unavailable
    if (tacos === null) {
      const adSales = parseFloat(totals?.sales || 0);
      const spend = parseFloat(totals?.spend || 0);
      if (adSales > 0 && spend > 0) {
        totalRevenue = adSales;
        tacos = (spend / adSales * 100).toFixed(2);
        tacosSource = 'ads_attributed';
      }
    }

    const calcDelta = (curr, prevVal) => {
      if (!prevVal || prevVal === 0) return null;
      return ((curr - prevVal) / prevVal * 100).toFixed(1);
    };

    res.json({
      period: { start, end },
      totals: {
        impressions: parseInt(totals?.impressions || 0),
        clicks: parseInt(totals?.clicks || 0),
        spend: parseFloat(totals?.spend || 0).toFixed(2),
        sales: parseFloat(totals?.sales || 0).toFixed(2),
        orders: parseInt(totals?.orders || 0),
        ctr: parseFloat(totals?.ctr || 0).toFixed(4),
        cpc: parseFloat(totals?.cpc || 0).toFixed(4),
        acos: parseFloat(totals?.acos || 0).toFixed(2),
        roas: parseFloat(totals?.roas || 0).toFixed(2),
        tacos,
        tacosSource,
        totalRevenue: totalRevenue ? totalRevenue.toFixed(2) : null,
      },
      deltas: {
        spend: calcDelta(totals?.spend, prev?.spend),
        sales: calcDelta(totals?.sales, prev?.sales),
        acos: calcDelta(totals?.acos, prev?.acos),
        roas: calcDelta(totals?.roas, prev?.roas),
      },
      trend,
    });
  } catch (err) {
    next(err);
  }
});

// GET /metrics/top-campaigns?limit=10&metric=spend
router.get("/top-campaigns", async (req, res, next) => {
  try {
    const { limit = 10, metric = "spend", startDate, endDate } = req.query;
    const start = startDate || new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const end = endDate || new Date().toISOString().split("T")[0];

    const metricMap = { spend: "SUM(cost)", sales: "SUM(sales_14d)", roas: "CASE WHEN SUM(cost)>0 THEN SUM(sales_14d)/SUM(cost) END" };
    const orderBy = metricMap[metric] || "SUM(cost)";

    const { rows } = await query(
      `SELECT c.id, c.name, c.campaign_type, c.state,
              SUM(m.impressions) as impressions, SUM(m.clicks) as clicks,
              SUM(m.cost) as spend, SUM(m.sales_14d) as sales,
              CASE WHEN SUM(m.clicks)>0 THEN SUM(m.cost)/SUM(m.clicks) END as cpc,
              CASE WHEN SUM(m.sales_14d)>0 THEN SUM(m.cost)/SUM(m.sales_14d)*100 END as acos,
              CASE WHEN SUM(m.cost)>0 THEN SUM(m.sales_14d)/SUM(m.cost) END as roas
       FROM fact_metrics_daily m
       JOIN campaigns c ON c.amazon_campaign_id = m.amazon_id AND c.workspace_id = m.workspace_id
       WHERE m.workspace_id = $1 AND m.date BETWEEN $2 AND $3 AND m.entity_type = 'campaign'
       GROUP BY c.id, c.name, c.campaign_type, c.state
       ORDER BY ${orderBy} DESC NULLS LAST
       LIMIT $4`,
      [req.workspaceId, start, end, parseInt(limit)]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /metrics/by-type — campaign type breakdown
router.get("/by-type", async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const start = startDate || new Date(Date.now() - 7*86400000).toISOString().split("T")[0];
    const end = endDate || new Date().toISOString().split("T")[0];
    const { rows } = await query(
      `SELECT campaign_type,
              SUM(impressions) as impressions, SUM(clicks) as clicks,
              SUM(cost) as spend, SUM(sales_14d) as sales,
              CASE WHEN SUM(sales_14d)>0 THEN SUM(cost)/SUM(sales_14d)*100 END as acos,
              CASE WHEN SUM(cost)>0 THEN SUM(sales_14d)/SUM(cost) END as roas
       FROM fact_metrics_daily
       WHERE workspace_id = $1 AND date BETWEEN $2 AND $3 AND entity_type = 'campaign'
       GROUP BY campaign_type ORDER BY SUM(cost) DESC`,
      [req.workspaceId, start, end]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /metrics/backfill
// Queue a metrics backfill job for the current workspace (last 60 days by default)
router.post("/backfill", async (req, res, next) => {
  try {
    logger.info("POST /metrics/backfill reached", { workspaceId: req.workspaceId, body: req.body });
    const { dateFrom, dateTo } = req.body;

    const dateTo_  = dateTo || (() => {
      const d = new Date(); d.setDate(d.getDate() - 1);
      return d.toISOString().split("T")[0];
    })();
    const dateFrom_ = dateFrom || (() => {
      const d = new Date(); d.setDate(d.getDate() - 60);
      return d.toISOString().split("T")[0];
    })();

    const job = await queueMetricsBackfill(req.workspaceId, dateFrom_, dateTo_);

    logger.info("Metrics backfill queued", { workspaceId: req.workspaceId, dateFrom: dateFrom_, dateTo: dateTo_, jobId: job.id });
    res.json({ queued: true, jobId: job.id, dateFrom: dateFrom_, dateTo: dateTo_ });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
