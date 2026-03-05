const { CronJob } = require("cron");
const { queueEntitySync, queueReportPipeline } = require("./workers");
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
          await queueEntitySync(id, ["campaigns", "ad_groups", "keywords"]);
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

  jobs = [entitySyncJob, reportSyncJob];
  logger.info("Scheduler started");
}

function stopScheduler() {
  jobs.forEach((j) => j.stop());
}

module.exports = { startScheduler, stopScheduler };
