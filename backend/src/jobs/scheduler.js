const { CronJob } = require("cron");
const { queueEntitySync, queueReportPipeline, queueRuleExecution, queueMetricsBackfill, queueAiAnalysis } = require("./workers");
const { query } = require("../db/pool");
const logger = require("../config/logger");

const SCHEDULE_INTERVALS = {
  hourly: 60 * 60 * 1000,               // 1 hour
  daily:  23 * 60 * 60 * 1000,          // 23 hours (avoid drift)
  weekly: 6.5 * 24 * 60 * 60 * 1000,   // 6.5 days
};

let jobs = [];

async function startScheduler() {
  // ─── Smart entity sync: runs every hour, syncs only "due" connections ─────
  const entitySyncJob = new CronJob("0 * * * *", async () => {
    logger.info("Cron: Checking connections due for entity sync");
    try {
      const { rows: connections } = await query(`
        SELECT
          c.id as connection_id,
          c.sync_schedule,
          MAX(p.last_synced_at) as last_synced_at,
          array_agg(p.id) FILTER (WHERE p.is_attached = TRUE) as profile_ids
        FROM amazon_connections c
        JOIN amazon_profiles p ON p.connection_id = c.id
        WHERE c.status = 'active' AND p.is_attached = TRUE
        GROUP BY c.id, c.sync_schedule
      `);

      let syncCount = 0;
      for (const conn of connections) {
        const interval = SCHEDULE_INTERVALS[conn.sync_schedule] || SCHEDULE_INTERVALS.daily;
        const lastSync = conn.last_synced_at ? new Date(conn.last_synced_at) : new Date(0);
        const isDue = (Date.now() - lastSync.getTime()) >= interval;

        if (isDue && conn.profile_ids?.length) {
          for (const profileId of conn.profile_ids) {
            await queueEntitySync(profileId, ["campaigns", "ad_groups", "keywords", "product_ads", "targets", "negative_keywords", "negative_targets", "portfolios"]);
          }
          syncCount += conn.profile_ids.length;
          logger.info("Cron: Queued sync for connection", {
            connectionId: conn.connection_id,
            schedule: conn.sync_schedule,
            profiles: conn.profile_ids.length,
          });
        }
      }
      logger.info(`Cron: Entity sync check complete — queued ${syncCount} profiles`);
    } catch (err) {
      logger.error("Cron entity sync failed", { error: err.message });
    }
  }, null, true, "UTC");

  // ─── Daily reports: every day at 06:00 UTC ───────────────────────────────
  const reportSyncJob = new CronJob(
    `0 ${process.env.REPORT_SYNC_HOUR_UTC || 6} * * *`,
    async () => {
      logger.info("Cron: Queuing daily reports");
      try {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const dateStr = yesterday.toISOString().split("T")[0];
        const { rows } = await query(
          `SELECT p.id FROM amazon_profiles p
           JOIN amazon_connections c ON c.id = p.connection_id
           WHERE p.is_attached = TRUE AND c.status = 'active'`
        );
        for (const { id } of rows) {
          for (const [type, level] of [
            ["SP", "campaign"],
            ["SP", "keyword"],
            ["SP", "target"],
            ["SP", "advertised_product"],
            ["SB", "campaign"],
            ["SD", "campaign"],
          ]) {
            await queueReportPipeline(id, type, level, dateStr, dateStr);
          }
        }
        logger.info(`Cron: Queued reports for ${rows.length} profiles`);
      } catch (err) {
        logger.error("Cron reports failed", { error: err.message });
      }
    }, null, true, "UTC"
  );

  // ─── Rule execution: every hour ────────────────────────────────────────────
  const ruleEngineJob = new CronJob(
    "0 * * * *",
    async () => {
      logger.info("Cron: Queuing rule execution for all workspaces with active rules");
      try {
        const { rows } = await query(
          `SELECT DISTINCT w.id FROM workspaces w
           JOIN rules r ON r.workspace_id = w.id
           WHERE r.is_active = TRUE`
        );
        for (const { id } of rows) {
          await queueRuleExecution(id);
        }
        logger.info(`Cron: Queued rule execution for ${rows.length} workspaces`);
      } catch (err) {
        logger.error("Cron rule execution failed", { error: err.message });
      }
    },
    null, true, "UTC"
  );

  // ─── Daily metrics backfill: every day at 06:30 UTC ──────────────────────
  const metricsBackfillJob = new CronJob(
    "30 6 * * *",
    async () => {
      logger.info("Cron: Queuing daily metrics backfill (last 2 days) for all workspaces");
      try {
        const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
        const twoDaysAgo = new Date(); twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
        const dateTo   = yesterday.toISOString().split("T")[0];
        const dateFrom = twoDaysAgo.toISOString().split("T")[0];
        const { rows } = await query(
          `SELECT DISTINCT p.workspace_id FROM amazon_profiles p
           JOIN amazon_connections c ON c.id = p.connection_id
           WHERE p.is_attached = TRUE AND c.status = 'active' AND p.workspace_id IS NOT NULL`
        );
        for (const { workspace_id } of rows) {
          await queueMetricsBackfill(workspace_id, dateFrom, dateTo);
        }
        logger.info(`Cron: Queued metrics backfill for ${rows.length} workspaces`);
      } catch (err) {
        logger.error("Cron metrics backfill failed", { error: err.message });
      }
    },
    null, true, "UTC"
  );

  // ─── Daily AI analysis: every day at 07:00 UTC ────────────────────────────
  const aiAnalysisJob = new CronJob(
    "0 7 * * *",
    async () => {
      logger.info("Cron: Queuing AI analysis for all active workspaces");
      try {
        const { rows } = await query(
          `SELECT DISTINCT p.workspace_id FROM amazon_profiles p
           JOIN amazon_connections c ON c.id = p.connection_id
           WHERE p.is_attached = TRUE AND c.status = 'active' AND p.workspace_id IS NOT NULL`
        );
        for (const { workspace_id } of rows) {
          await queueAiAnalysis(workspace_id);
        }
        logger.info(`Cron: Queued AI analysis for ${rows.length} workspaces`);
      } catch (err) {
        logger.error("Cron AI analysis failed", { error: err.message });
      }
    },
    null, true, "UTC"
  );

  // ─── BSR sync: every 6 hours ───────────────────────────────────────────────
  const bsrSyncJob = new CronJob("0 */6 * * *", async () => {
    if (!process.env.SP_API_REFRESH_TOKEN) return; // skip if not configured
    logger.info("Cron: Starting BSR sync for all active products");
    try {
      const { getCatalogItem } = require("../services/amazon/spClient");
      const { rows: products } = await query(
        "SELECT id, asin, marketplace_id FROM products WHERE is_active = true"
      );

      for (const product of products) {
        try {
          const data = await getCatalogItem(product.asin, product.marketplace_id);

          await query(
            "UPDATE products SET title=$1, brand=$2, image_url=$3, updated_at=NOW() WHERE id=$4",
            [data.title, data.brand, data.imageUrl, product.id]
          );

          const allRanks = [...data.classificationRanks, ...data.displayGroupRanks];
          const best = allRanks.reduce((b, r) => (!b || r.rank < b.rank ? r : b), null);

          await query(
            `INSERT INTO bsr_snapshots
               (product_id, classification_ranks, display_group_ranks, best_rank, best_category)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              product.id,
              JSON.stringify(data.classificationRanks),
              JSON.stringify(data.displayGroupRanks),
              best?.rank || null,
              best?.title || null,
            ]
          );

          // Throttle: 200ms between requests (SP-API rate: 2 req/sec)
          await new Promise(r => setTimeout(r, 200));
        } catch (err) {
          logger.warn("BSR sync failed for product", { asin: product.asin, error: err.message });
        }
      }
      logger.info("Cron: BSR sync complete", { count: products.length });
    } catch (err) {
      logger.error("Cron BSR sync failed", { error: err.message });
    }
  }, null, true, "UTC");

  jobs = [entitySyncJob, reportSyncJob, ruleEngineJob, metricsBackfillJob, aiAnalysisJob, bsrSyncJob];
  logger.info("Scheduler started with smart sync scheduling");
}

function stopScheduler() { jobs.forEach(j => j.stop()); }

module.exports = { startScheduler, stopScheduler };
