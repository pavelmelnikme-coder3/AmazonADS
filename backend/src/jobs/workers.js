/**
 * BullMQ Job Queue Configuration
 * Workers: entity sync, report pipeline, bulk operations
 */

const { Queue, Worker, QueueEvents } = require("bullmq");
const { createRedisConnection } = require("../config/redis");
const logger = require("../config/logger");
const { fetchCampaigns, syncCampaigns, fetchAdGroups, syncAdGroups, fetchKeywords, syncKeywords } = require("../services/amazon/entities");
const { runReportingPipeline } = require("../services/amazon/reporting");
const { query } = require("../db/pool");

// ─── Queue definitions ────────────────────────────────────────────────────────
const QUEUES = {
  ENTITY_SYNC:   "entity-sync",
  REPORT:        "report-pipeline",
  BULK_OPS:      "bulk-operations",
  RULE_ENGINE:   "rule-engine",
  ALERT_CHECK:   "alert-check",
};

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
};

let queues = {};

function getQueue(name) {
  if (!queues[name]) {
    queues[name] = new Queue(name, {
      connection: createRedisConnection(),
      defaultJobOptions,
    });
  }
  return queues[name];
}

// ─── Add jobs ─────────────────────────────────────────────────────────────────
async function queueEntitySync(profileId, entityTypes = ["campaigns", "ad_groups", "keywords"], priority = 5) {
  const queue = getQueue(QUEUES.ENTITY_SYNC);
  return queue.add("sync", { profileId, entityTypes }, { priority });
}

async function queueReportPipeline(profileId, campaignType, reportLevel, startDate, endDate) {
  const queue = getQueue(QUEUES.REPORT);
  return queue.add("run", { profileId, campaignType, reportLevel, startDate, endDate });
}

async function queueBulkOperation(workspaceId, operationType, items) {
  const queue = getQueue(QUEUES.BULK_OPS);
  // Split into batches of 100
  const batchSize = 100;
  for (let i = 0; i < items.length; i += batchSize) {
    await queue.add("batch", {
      workspaceId,
      operationType,
      items: items.slice(i, i + batchSize),
      batchIndex: Math.floor(i / batchSize),
    });
  }
}

// ─── Workers ──────────────────────────────────────────────────────────────────
let workers = [];

async function startWorkers() {
  // Entity Sync Worker
  const syncWorker = new Worker(
    QUEUES.ENTITY_SYNC,
    async (job) => {
      const { profileId, entityTypes } = job.data;
      logger.info("Entity sync started", { profileId, entityTypes });

      // Get profile with connection info
      const { rows } = await query(
        `SELECT p.*, c.id as connection_id, c.status as conn_status
         FROM amazon_profiles p
         JOIN amazon_connections c ON c.id = p.connection_id
         WHERE p.id = $1 AND p.is_attached = TRUE`,
        [profileId]
      );

      if (!rows.length) {
        throw new Error(`Profile ${profileId} not found or not attached`);
      }

      const profile = rows[0];
      if (profile.conn_status !== "active") {
        throw new Error(`Connection ${profile.connection_id} is not active (status: ${profile.conn_status})`);
      }

      await query(
        "UPDATE amazon_profiles SET sync_status = 'syncing', updated_at = NOW() WHERE id = $1",
        [profileId]
      );

      const results = {};

      if (entityTypes.includes("campaigns")) {
        await job.updateProgress(10);
        const campaigns = await fetchCampaigns(profile);
        const count = await syncCampaigns(profile, campaigns);
        results.campaigns = count;
        logger.info("Campaigns synced", { profileId, count });
      }

      if (entityTypes.includes("ad_groups")) {
        await job.updateProgress(40);
        for (const type of ["SP", "SB", "SD"]) {
          try {
            const adGroups = await fetchAdGroups(profile, type);
            await syncAdGroups(profile, adGroups, type);
            results.ad_groups = (results.ad_groups || 0) + adGroups.length;
          } catch (e) {
            logger.warn(`Failed to sync ${type} ad groups`, { error: e.message });
          }
        }
      }

      if (entityTypes.includes("keywords")) {
        await job.updateProgress(70);
        const keywords = await fetchKeywords(profile);
        await syncKeywords(profile, keywords);
        results.keywords = keywords.length;
      }

      await job.updateProgress(100);
      await query(
        "UPDATE amazon_profiles SET sync_status = 'synced', last_synced_at = NOW(), updated_at = NOW() WHERE id = $1",
        [profileId]
      );

      logger.info("Entity sync completed", { profileId, results });
      return results;
    },
    {
      connection: createRedisConnection(),
      concurrency: 3,
    }
  );

  syncWorker.on("failed", async (job, err) => {
    logger.error("Entity sync failed", { jobId: job?.id, error: err.message });
    if (job?.data?.profileId) {
      await query(
        "UPDATE amazon_profiles SET sync_status = 'error', updated_at = NOW() WHERE id = $1",
        [job.data.profileId]
      ).catch(() => {});
    }
  });

  // Report Pipeline Worker
  const reportWorker = new Worker(
    QUEUES.REPORT,
    async (job) => {
      const { profileId, campaignType, reportLevel, startDate, endDate } = job.data;
      logger.info("Report pipeline started", { profileId, campaignType, reportLevel, startDate, endDate });

      const { rows } = await query(
        `SELECT p.*, c.id as connection_id
         FROM amazon_profiles p
         JOIN amazon_connections c ON c.id = p.connection_id
         WHERE p.id = $1`,
        [profileId]
      );

      if (!rows.length) throw new Error(`Profile ${profileId} not found`);

      return runReportingPipeline({
        profileDbRecord: rows[0],
        campaignType,
        reportLevel,
        startDate,
        endDate,
      });
    },
    {
      connection: createRedisConnection(),
      concurrency: 2, // Limit concurrent report downloads
    }
  );

  reportWorker.on("failed", (job, err) => {
    logger.error("Report pipeline failed", { jobId: job?.id, error: err.message });
  });

  workers = [syncWorker, reportWorker];
  logger.info("Workers started", { queues: Object.values(QUEUES) });
}

async function stopWorkers() {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(Object.values(queues).map((q) => q.close()));
}

module.exports = {
  getQueue,
  queueEntitySync,
  queueReportPipeline,
  queueBulkOperation,
  startWorkers,
  stopWorkers,
  QUEUES,
};
