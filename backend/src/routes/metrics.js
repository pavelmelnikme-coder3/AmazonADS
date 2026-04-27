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

    // Daily trend. Joins per-day SP-API revenue so each row carries a true
    // per-day TACoS (cost / total_sales). Days without sp_orders coverage
    // get tacos=null and total_revenue=null — the frontend draws a gap so
    // users notice missing revenue rather than seeing a misleading 0%.
    // CTE column aliased `rev_date` to avoid ambiguity with fact_metrics_daily.date.
    const { rows: trend } = await query(
      `WITH daily_revenue AS (
         SELECT purchase_date::date AS rev_date,
                SUM(order_total_amount) AS revenue
         FROM sp_orders
         WHERE workspace_id = $1
           AND purchase_date::date BETWEEN $2 AND $3
           AND order_status NOT IN ('Canceled', 'Unfulfillable')
         GROUP BY purchase_date::date
       )
       SELECT date,
         SUM(impressions) as impressions,
         SUM(clicks)      as clicks,
         SUM(cost)        as spend,
         SUM(sales_14d)   as sales,
         SUM(orders_14d)  as orders,
         CASE WHEN SUM(impressions)>0 THEN SUM(clicks)::numeric/SUM(impressions)*100 ELSE 0 END as ctr,
         CASE WHEN SUM(clicks)>0 THEN SUM(cost)/SUM(clicks) ELSE 0 END as cpc,
         CASE WHEN SUM(sales_14d)>0 THEN SUM(cost)/SUM(sales_14d)*100 ELSE 0 END as acos,
         CASE WHEN SUM(cost)>0 THEN SUM(sales_14d)/SUM(cost) ELSE 0 END as roas,
         dr.revenue AS total_revenue,
         CASE WHEN dr.revenue > 0 THEN SUM(cost)/dr.revenue*100 END as tacos
       FROM fact_metrics_daily
       LEFT JOIN daily_revenue dr ON dr.rev_date = date
       WHERE ${where} AND entity_type = 'campaign'
       GROUP BY date, dr.revenue
       ORDER BY date`,
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

    // TACoS = ad spend / total sales (paid + organic) × 100.
    // Apples-to-apples: when sp_orders coverage doesn't reach the period end
    // (sync still catching up), align spend to the same date range. Otherwise
    // a 7-day spend divided by a 5-day revenue produces a misleadingly low
    // TACoS. We expose the aligned period back to the UI so users can see
    // "TACoS for Apr 20-24 (5d/7d)" rather than blindly trust 3.6%.
    let tacos = null;
    let totalRevenue = null;
    let tacosSource = null; // 'sp_api' | null
    let tacosPeriod = null; // { start, end, days, requestedDays }
    try {
      const { rows: [spInfo] } = await query(
        `SELECT
           SUM(order_total_amount)         AS total_revenue,
           MIN(purchase_date)::date        AS first_rev_date,
           MAX(purchase_date)::date        AS last_rev_date,
           COUNT(DISTINCT purchase_date::date) AS coverage_days
         FROM sp_orders
         WHERE workspace_id = $1 AND purchase_date::date BETWEEN $2 AND $3
         AND order_status NOT IN ('Canceled', 'Unfulfillable')`,
        [req.workspaceId, start, end]
      );
      if (spInfo?.total_revenue && spInfo.last_rev_date) {
        totalRevenue = parseFloat(spInfo.total_revenue);
        const alignedEnd = spInfo.last_rev_date.toISOString().split("T")[0];
        const { rows: [alignedSpend] } = await query(
          `SELECT SUM(cost) AS spend FROM fact_metrics_daily
           WHERE workspace_id = $1 AND date BETWEEN $2 AND $3 AND entity_type='campaign'`,
          [req.workspaceId, start, alignedEnd]
        );
        const spendForTacos = parseFloat(alignedSpend?.spend || 0);
        if (totalRevenue > 0 && spendForTacos > 0) {
          tacos = (spendForTacos / totalRevenue * 100).toFixed(2);
          tacosSource = 'sp_api';
          // Inclusive day count between start and alignedEnd
          const reqDays = Math.round((new Date(end) - new Date(start))/86400000) + 1;
          const covDays = Math.round((new Date(alignedEnd) - new Date(start))/86400000) + 1;
          tacosPeriod = { start, end: alignedEnd, days: covDays, requestedDays: reqDays };
        }
      }
    } catch {}

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
        tacosPeriod,
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
