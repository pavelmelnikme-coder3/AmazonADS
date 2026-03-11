const { CronJob } = require("cron");
const { queueEntitySync, queueReportPipeline, queueRuleEngine, queueRuleExecution, queueMetricsBackfill, queueAiAnalysis } = require("./workers");
const { query } = require("../db/pool");
const logger = require("../config/logger");

let jobs = [];

async function startScheduler() {
  // ─── Daily entity sync: every 2 hours ────────────────────────────────────
  const entitySyncJob = new CronJob(
    "0 */2 * * *",
    async () => {
      logger.info("Cron: Queuing entity sync for all active profiles");
      try {
        const { rows } = await query(
          `SELECT p.id FROM amazon_profiles p
           JOIN amazon_connections c ON c.id = p.connection_id
           WHERE p.is_attached = TRUE AND c.status = 'active'`
        );
        for (const { id } of rows) {
          await queueEntitySync(id, ["campaigns", "ad_groups", "keywords", "product_ads", "targets", "negative_keywords", "negative_targets", "portfolios"]);
        }
        logger.info(`Cron: Queued entity sync for ${rows.length} profiles`);
      } catch (err) {
        logger.error("Cron entity sync failed", { error: err.message });
      }
    },
    null, true, "UTC"
  );

  // ─── Daily reports: every day at 06:00 UTC ────────────────────────────────
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
          for (const [type, level] of [["SP","campaign"],["SB","campaign"],["SD","campaign"]]) {
            await queueReportPipeline(id, type, level, dateStr, dateStr);
          }
        }
        logger.info(`Cron: Queued reports for ${rows.length} profiles`);
      } catch (err) {
        logger.error("Cron reports failed", { error: err.message });
      }
    },
    null, true, "UTC"
  );

  // ─── Rule execution: every hour ────────────────────────────────────────────
  // Queues a targeted execution per workspace; engine filters by schedule_type internally
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

  jobs = [entitySyncJob, reportSyncJob, ruleEngineJob, metricsBackfillJob, aiAnalysisJob];
  logger.info("Scheduler started");
}

function stopScheduler() {
  jobs.forEach((j) => j.stop());
}

module.exports = { startScheduler, stopScheduler };
