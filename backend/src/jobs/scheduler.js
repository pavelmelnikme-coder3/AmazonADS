const { CronJob } = require("cron");
const { queueEntitySync, queueReportPipeline, queueRuleExecution, queueMetricsBackfill, queueAiAnalysis, queueSpSync, queueRankCheck } = require("./workers");
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
            ["SP", "searchTerm"],
            ["SP", "target"],
            ["SP", "advertised_product"],
            ["SB", "campaign"],
            ["SB", "keyword"],
            ["SB", "ad_group"],
            ["SD", "campaign"],
            ["SD", "ad_group"],
            ["SD", "target"],
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

  // ─── SP-API sync: every 4 hours (BSR + inventory + pricing) ─────────────────
  const spSyncJob = new CronJob("0 */4 * * *", async () => {
    if (!process.env.SP_API_REFRESH_TOKEN) return;
    try {
      const { rows } = await query(
        "SELECT DISTINCT workspace_id, marketplace_id FROM products WHERE is_active = true"
      );
      for (const { workspace_id, marketplace_id } of rows) {
        await queueSpSync(workspace_id, marketplace_id, ["bsr", "inventory", "pricing"]);
      }
      logger.info("Cron: SP sync queued", { pairs: rows.length });
    } catch (err) {
      logger.error("Cron SP sync failed", { error: err.message });
    }
  }, null, true, "UTC");

  // ─── SP-API orders + financials: daily at 05:00 UTC ──────────────────────────
  const spDailyJob = new CronJob("0 5 * * *", async () => {
    if (!process.env.SP_API_REFRESH_TOKEN) return;
    try {
      const { rows } = await query(
        "SELECT DISTINCT workspace_id, marketplace_id FROM products WHERE is_active = true"
      );
      for (const { workspace_id, marketplace_id } of rows) {
        await queueSpSync(workspace_id, marketplace_id, ["orders", "financials"]);
      }
      logger.info("Cron: SP orders+financials queued", { pairs: rows.length });
    } catch (err) {
      logger.error("Cron SP daily sync failed", { error: err.message });
    }
  }, null, true, "UTC");

  // ─── Daily cleanup: delete failed reports older than 2 days ─────────────────
  const reportCleanupJob = new CronJob("0 4 * * *", async () => {
    try {
      const { rowCount } = await query(
        `DELETE FROM report_requests WHERE status = 'failed' AND created_at < NOW() - INTERVAL '2 days'`
      );
      logger.info("Cron: Cleaned up failed reports", { deleted: rowCount });
    } catch (err) {
      logger.error("Cron report cleanup failed", { error: err.message });
    }
  }, null, true, "UTC");

  // ─── Keyword rank check: daily at 03:00 UTC ──────────────────────────────────
  const rankCheckJob = new CronJob("0 3 * * *", async () => {
    try {
      const { rows } = await query(
        `SELECT DISTINCT workspace_id FROM tracked_keywords WHERE is_active = TRUE`
      );
      for (const { workspace_id } of rows) {
        await queueRankCheck(workspace_id);
      }
      logger.info("Cron: Rank check queued", { workspaces: rows.length });
    } catch (err) {
      logger.error("Cron rank check failed", { error: err.message });
    }
  }, null, true, "UTC");

  jobs = [entitySyncJob, reportSyncJob, ruleEngineJob, metricsBackfillJob, aiAnalysisJob, spSyncJob, spDailyJob, reportCleanupJob, rankCheckJob];
  logger.info("Scheduler started with smart sync scheduling");
}

function stopScheduler() { jobs.forEach(j => j.stop()); }

module.exports = { startScheduler, stopScheduler };
