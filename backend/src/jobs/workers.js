/**
 * BullMQ Job Queue Configuration
 * Workers: entity sync, report pipeline, bulk operations, rule engine, metrics backfill
 */

const { Queue, Worker, QueueEvents } = require("bullmq");
const { createRedisConnection, getRedis } = require("../config/redis");
const logger = require("../config/logger");
const {
  fetchCampaigns, syncCampaigns,
  fetchAdGroups, syncAdGroups,
  fetchKeywords, syncKeywords,
  fetchPortfolios, syncPortfolios,
  fetchProductAds, syncProductAds,
  fetchTargets, syncTargets,
  fetchNegativeKeywords, syncNegativeKeywords,
  fetchNegativeTargets, syncNegativeTargets,
} = require("../services/amazon/entities");
const { runReportingPipeline, queueMetricsBackfillJobs } = require("../services/amazon/reporting");
const { generateRecommendations } = require("../services/ai/orchestrator");
const { executeRules } = require("../services/rules/engine");
const { query } = require("../db/pool");

// ─── Queue definitions ────────────────────────────────────────────────────────
const QUEUES = {
  ENTITY_SYNC:      "entity-sync",
  REPORT:           "report-pipeline",
  BULK_OPS:         "bulk-operations",
  RULE_ENGINE:      "rule-engine",
  RULE_EXECUTION:   "rule-execution",
  ALERT_CHECK:      "alert-check",
  METRICS_BACKFILL: "metrics-backfill",
  AI_ANALYSIS:      "ai-analysis",
  SP_SYNC:          "sp-sync",
  RANK_CHECK:       "rank-check",
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
async function queueEntitySync(profileId, entityTypes = ["campaigns", "ad_groups", "keywords", "portfolios", "product_ads", "targets", "negative_keywords", "negative_targets"], priority = 5) {
  const queue = getQueue(QUEUES.ENTITY_SYNC);
  return queue.add("sync", { profileId, entityTypes }, { priority });
}

async function queueReportPipeline(profileId, campaignType, reportLevel, startDate, endDate) {
  const queue = getQueue(QUEUES.REPORT);
  return queue.add("run", { profileId, campaignType, reportLevel, startDate, endDate });
}

async function queueMetricsBackfill(workspaceId, dateFrom, dateTo) {
  const queue = getQueue(QUEUES.METRICS_BACKFILL);
  return queue.add("backfill", { workspaceId, dateFrom, dateTo }, { priority: 3 });
}

async function queueSpSync(workspaceId, marketplaceId, syncTypes = ["bsr", "inventory", "pricing"], priority = 5) {
  const queue = getQueue(QUEUES.SP_SYNC);
  return queue.add("sync", { workspaceId, marketplaceId, syncTypes }, { priority });
}

async function queueAiAnalysis(workspaceId, locale = "en") {
  const queue = getQueue(QUEUES.AI_ANALYSIS);
  return queue.add("analyze", { workspaceId, locale }, { priority: 5 });
}

async function queueRuleEngine(workspaceId) {
  const queue = getQueue(QUEUES.RULE_ENGINE);
  return queue.add("evaluate", { workspaceId });
}

async function queueRuleExecution(workspaceId, ruleId = null) {
  const queue = getQueue(QUEUES.RULE_EXECUTION);
  // jobId deduplication: if a job for this workspace is already pending/active,
  // BullMQ will not enqueue a second one — preventing race conditions between cron ticks.
  const jobId = ruleId ? `rule_${ruleId}_${workspaceId}` : `workspace_${workspaceId}`;
  return queue.add("execute", { workspaceId, ruleId }, { jobId });
}

async function queueRankCheck(workspaceId) {
  const queue = getQueue(QUEUES.RANK_CHECK);
  const jobId = `rank_${workspaceId}`;
  return queue.add("check", { workspaceId }, { jobId });
}

async function queueBulkOperation(workspaceId, operationType, items) {
  const queue = getQueue(QUEUES.BULK_OPS);
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
  // ─── Entity Sync Worker ────────────────────────────────────────────────────
  const syncWorker = new Worker(
    QUEUES.ENTITY_SYNC,
    async (job) => {
      const { profileId, entityTypes } = job.data;
      logger.info("Entity sync started", { profileId, entityTypes });

      const { rows } = await query(
        `SELECT p.*, c.status as conn_status
         FROM amazon_profiles p
         JOIN amazon_connections c ON c.id = p.connection_id
         WHERE p.id = $1 AND p.is_attached = TRUE`,
        [profileId]
      );

      if (!rows.length) throw new Error(`Profile ${profileId} not found or not attached`);
      const profile = rows[0];

      logger.info("Entity sync: using connection for profile", {
        profileDbId: profile.id,
        amazonProfileId: profile.profile_id,
        connectionId: profile.connection_id,
        connStatus: profile.conn_status,
        marketplace: profile.marketplace,
        marketplaceId: profile.marketplace_id,
      });

      if (profile.conn_status !== "active") {
        throw new Error(`Connection ${profile.connection_id} is not active (status: ${profile.conn_status})`);
      }

      await query(
        "UPDATE amazon_profiles SET sync_status = 'syncing', updated_at = NOW() WHERE id = $1",
        [profileId]
      );

      const results = {};
      let progress = 5;

      // ── Portfolios (first — campaigns may reference them) ──────────────────
      if (entityTypes.includes("portfolios")) {
        await job.updateProgress(progress); progress += 5;
        try {
          const portfolios = await fetchPortfolios(profile);
          results.portfolios = await syncPortfolios(profile, portfolios);
        } catch (e) {
          logger.warn("Failed to sync portfolios", { error: e.message });
          results.portfolios = 0;
        }
      }

      // ── Campaigns ─────────────────────────────────────────────────────────
      if (entityTypes.includes("campaigns")) {
        await job.updateProgress(progress); progress += 15;
        const campaigns = await fetchCampaigns(profile);
        results.campaigns = await syncCampaigns(profile, campaigns);
      }

      // ── Ad Groups ─────────────────────────────────────────────────────────
      if (entityTypes.includes("ad_groups")) {
        await job.updateProgress(progress); progress += 10;
        try {
          const adGroups = await fetchAdGroups(profile);
          await syncAdGroups(profile, adGroups);
          results.ad_groups = adGroups.length;
        } catch (e) {
          logger.warn("Failed to sync ad groups", { error: e.message });
        }
      }

      // ── Keywords ──────────────────────────────────────────────────────────
      if (entityTypes.includes("keywords")) {
        await job.updateProgress(progress); progress += 10;
        const keywords = await fetchKeywords(profile);
        results.keywords = await syncKeywords(profile, keywords);
      }

      // ── Product Ads ───────────────────────────────────────────────────────
      if (entityTypes.includes("product_ads")) {
        await job.updateProgress(progress); progress += 10;
        try {
          const productAds = await fetchProductAds(profile);
          results.product_ads = await syncProductAds(profile, productAds);
        } catch (e) {
          logger.warn("Failed to sync product ads", { error: e.message });
          results.product_ads = 0;
        }
      }

      // ── Targets (SP + SD) ─────────────────────────────────────────────────
      if (entityTypes.includes("targets")) {
        await job.updateProgress(progress); progress += 10;
        for (const type of ["SP", "SD"]) {
          try {
            const targets = await fetchTargets(profile, type);
            results.targets = (results.targets || 0) + await syncTargets(profile, targets, type);
          } catch (e) {
            logger.warn(`Failed to sync ${type} targets`, { error: e.message });
          }
        }
      }

      // ── Negative Keywords ─────────────────────────────────────────────────
      if (entityTypes.includes("negative_keywords")) {
        await job.updateProgress(progress); progress += 10;
        try {
          const negKws = await fetchNegativeKeywords(profile);
          results.negative_keywords = await syncNegativeKeywords(profile, negKws);
        } catch (e) {
          logger.warn("Failed to sync negative keywords", { error: e.message });
          results.negative_keywords = 0;
        }
      }

      // ── Negative Targets ──────────────────────────────────────────────────
      if (entityTypes.includes("negative_targets")) {
        await job.updateProgress(progress); progress += 5;
        for (const type of ["SP", "SD"]) {
          try {
            const negTargets = await fetchNegativeTargets(profile, type);
            results.negative_targets = (results.negative_targets || 0) + await syncNegativeTargets(profile, negTargets, type);
          } catch (e) {
            logger.warn(`Failed to sync ${type} negative targets`, { error: e.message });
          }
        }
      }

      await job.updateProgress(100);
      await query(
        "UPDATE amazon_profiles SET sync_status = 'synced', last_synced_at = NOW(), updated_at = NOW() WHERE id = $1",
        [profileId]
      );

      logger.info("Entity sync completed", { profileId, results });
      return results;
    },
    { connection: createRedisConnection(), concurrency: 5 }
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

  // ─── Report Pipeline Worker ────────────────────────────────────────────────
  const reportWorker = new Worker(
    QUEUES.REPORT,
    async (job) => {
      const { profileId, campaignType, reportLevel, startDate, endDate } = job.data;
      logger.info("Report pipeline started", { profileId, campaignType, reportLevel, startDate, endDate });

      const { rows } = await query(
        `SELECT p.*, c.status as conn_status
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
    // concurrency: 1 — Amazon Ads API throttles heavily when multiple report-create
    // requests fire simultaneously; sequential processing avoids 429 retries (15s+30s)
    { connection: createRedisConnection(), concurrency: 1 }
  );

  reportWorker.on("failed", (job, err) => {
    logger.error("Report pipeline failed", { jobId: job?.id, error: err.message });
  });

  // ─── Metrics Backfill Worker ───────────────────────────────────────────────
  const backfillWorker = new Worker(
    QUEUES.METRICS_BACKFILL,
    async (job) => {
      const { workspaceId, dateFrom, dateTo } = job.data;
      logger.info("Metrics backfill started", { workspaceId, dateFrom, dateTo });

      const result = await queueMetricsBackfillJobs(workspaceId, queueReportPipeline, dateFrom, dateTo);

      logger.info("Metrics backfill queued report jobs", result);
      return result;
    },
    { connection: createRedisConnection(), concurrency: 1 }
  );

  backfillWorker.on("failed", (job, err) => {
    logger.error("Metrics backfill failed", { jobId: job?.id, error: err.message });
  });

  // ─── Rule Engine Worker (legacy scheduler-based) ──────────────────────────
  const ruleEngineWorker = new Worker(
    QUEUES.RULE_ENGINE,
    async (job) => {
      const { workspaceId } = job.data;
      logger.info("Rule engine (legacy) started", { workspaceId });
      const result = await executeRules(workspaceId, null);
      logger.info("Rule engine (legacy) completed", { workspaceId, ...result });
      return result;
    },
    { connection: createRedisConnection(), concurrency: 1 }
  );

  ruleEngineWorker.on("failed", (job, err) => {
    logger.error("Rule engine worker failed", { jobId: job?.id, error: err.message });
  });

  // ─── Rule Execution Worker (targeted, per-rule) ────────────────────────────
  const ruleExecutionWorker = new Worker(
    QUEUES.RULE_EXECUTION,
    async (job) => {
      const { workspaceId, ruleId } = job.data;

      // Distributed lock — prevents two simultaneous runs for the same workspace
      // even if BullMQ lets a second job start while the first is still active.
      const redis   = getRedis();
      const lockKey = `rule_exec_lock:${workspaceId}`;
      const lockTTL = 300; // 5 min safety TTL — auto-released if process crashes

      const acquired = await redis.set(lockKey, job.id, "NX", "EX", lockTTL);
      if (!acquired) {
        logger.info("Rule execution skipped — another run is active for this workspace", {
          workspaceId, ruleId,
        });
        return { skipped: true, reason: "concurrent_run" };
      }

      try {
        logger.info("Rule execution started", { workspaceId, ruleId });
        const result = await executeRules(workspaceId, ruleId || null);
        logger.info("Rule execution completed", { workspaceId, ruleId, ...result });
        return result;
      } finally {
        // Release lock only if we still own it (guards against TTL expiry edge case)
        const current = await redis.get(lockKey);
        if (current === String(job.id)) {
          await redis.del(lockKey);
        }
      }
    },
    // concurrency: 1 — rules within a workspace run sequentially to prevent
    // simultaneous modifications to the same entity from different jobs.
    { connection: createRedisConnection(), concurrency: 1 }
  );

  ruleExecutionWorker.on("failed", (job, err) => {
    logger.error("Rule execution worker failed", { jobId: job?.id, error: err.message });
  });

  // ─── AI Analysis Worker ────────────────────────────────────────────────────
  const aiWorker = new Worker(
    QUEUES.AI_ANALYSIS,
    async (job) => {
      const { workspaceId, locale = "en" } = job.data;
      logger.info("AI analysis worker started", { workspaceId, locale });

      // Get all attached profiles for the workspace
      const { rows: profiles } = await query(
        `SELECT p.id FROM amazon_profiles p
         JOIN amazon_connections c ON c.id = p.connection_id
         WHERE p.workspace_id = $1 AND p.is_attached = TRUE AND c.status = 'active'`,
        [workspaceId]
      );

      if (!profiles.length) {
        logger.info("AI analysis: no active profiles", { workspaceId });
        return { workspaceId, recommendations: 0 };
      }

      let total = 0;
      // Run for the workspace (pass null profileDbId to aggregate all profiles)
      const recs = await generateRecommendations(workspaceId, null, locale);
      total += recs.length;

      logger.info("AI analysis worker completed", { workspaceId, recommendations: total });
      return { workspaceId, recommendations: total };
    },
    { connection: createRedisConnection(), concurrency: 1 }
  );

  aiWorker.on("failed", (job, err) => {
    logger.error("AI analysis worker failed", { jobId: job?.id, error: err.message });
  });

  const { syncBsr, syncInventory, syncOrders, syncFinancials, syncPricing } = require("../services/amazon/spSync");
  const { decrypt } = require("../config/encryption");
  const spSyncWorker = new Worker(
    QUEUES.SP_SYNC,
    async (job) => {
      const { workspaceId, marketplaceId, syncTypes } = job.data;
      // Resolve refresh token: env var fallback
      const refreshToken = process.env.SP_API_REFRESH_TOKEN || null;
      if (!refreshToken) {
        logger.warn("SP_SYNC: SP_API_REFRESH_TOKEN not configured, skipping", { workspaceId });
        return { skipped: true };
      }
      const results = {};
      const step = Math.floor(100 / syncTypes.length);
      let progress = 0;
      for (const type of syncTypes) {
        try {
          if (type === "bsr")        results.bsr        = await syncBsr(workspaceId, marketplaceId, refreshToken);
          if (type === "inventory")  results.inventory  = await syncInventory(workspaceId, marketplaceId, refreshToken);
          if (type === "orders")     results.orders     = await syncOrders(workspaceId, marketplaceId, refreshToken);
          if (type === "financials") results.financials = await syncFinancials(workspaceId, marketplaceId, refreshToken);
          if (type === "pricing")    results.pricing    = await syncPricing(workspaceId, marketplaceId, refreshToken);
        } catch (err) {
          logger.warn(`SP_SYNC: ${type} failed`, { workspaceId, error: err.message });
          results[type] = { error: err.message };
        }
        progress += step;
        await job.updateProgress(Math.min(progress, 99));
      }
      return { workspaceId, marketplaceId, results };
    },
    { connection: createRedisConnection(), concurrency: 2 }
  );
  spSyncWorker.on("failed", (job, err) => {
    logger.error("SP sync worker failed", { jobId: job?.id, error: err.message });
  });

  const { scrapeWorkspaceRanks } = require("../services/amazon/rankScraper");
  const { getRanksByAsin, isConfigured: jsConfigured } = require("../services/junglescout/client");

  async function jsCheckWorkspaceRanks(workspaceId) {
    const { rows: keywords } = await query(
      `SELECT id, asin, keyword, marketplace_id FROM tracked_keywords WHERE workspace_id = $1 AND is_active = TRUE`,
      [workspaceId]
    );
    if (!keywords.length) return { total: 0, found: 0 };

    const groups = {};
    for (const kw of keywords) {
      const key = `${kw.asin}|${kw.marketplace_id}`;
      if (!groups[key]) groups[key] = { asin: kw.asin, marketplaceId: kw.marketplace_id, keywords: [] };
      groups[key].keywords.push(kw);
    }

    let found = 0;
    for (const group of Object.values(groups)) {
      const rankMap = await getRanksByAsin(group.asin, group.marketplaceId);
      for (const kw of group.keywords) {
        const result = rankMap.get(kw.keyword) || { position: null, page: null, found: false, blocked: false };
        await query(
          `INSERT INTO keyword_rank_snapshots (tracked_keyword_id, position, page, found, blocked) VALUES ($1, $2, $3, $4, $5)`,
          [kw.id, result.position, result.page, result.found, result.blocked]
        );
        if (result.found) found++;
      }
      if (Object.keys(groups).length > 1) await new Promise(r => setTimeout(r, 300));
    }
    return { total: keywords.length, found };
  }

  const rankCheckWorker = new Worker(
    QUEUES.RANK_CHECK,
    async (job) => {
      const { workspaceId } = job.data;
      logger.info("Rank check started", { workspaceId });
      if (jsConfigured()) {
        const { total, found } = await jsCheckWorkspaceRanks(workspaceId);
        logger.info("Rank check complete (JS)", { workspaceId, total, found });
        return { workspaceId, total, found };
      }
      const results = await scrapeWorkspaceRanks(workspaceId, { query });
      const found = results.filter(r => r.found).length;
      const blocked = results.filter(r => r.blocked).length;
      logger.info("Rank check complete (scrape)", { workspaceId, total: results.length, found, blocked });
      return { workspaceId, total: results.length, found, blocked };
    },
    { connection: createRedisConnection(), concurrency: 1, limiter: { max: 1, duration: 3600000 } }
  );
  rankCheckWorker.on("failed", (job, err) => {
    logger.error("Rank check worker failed", { jobId: job?.id, error: err.message });
  });

  workers = [syncWorker, reportWorker, backfillWorker, ruleEngineWorker, ruleExecutionWorker, aiWorker, spSyncWorker, rankCheckWorker];
  logger.info("Workers started", { queues: Object.values(QUEUES) });

  // Mark stale processing/requested DB records as failed (left over from previous restarts)
  await query(
    `UPDATE report_requests SET status = 'failed', error_message = 'Stale: interrupted by server restart', updated_at = NOW()
     WHERE status IN ('processing', 'requested') AND updated_at < NOW() - INTERVAL '2 hours'`
  ).catch(e => logger.warn("Stale report cleanup failed", { error: e.message }));
}

async function stopWorkers() {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(Object.values(queues).map((q) => q.close()));
}

module.exports = {
  getQueue,
  queueEntitySync,
  queueReportPipeline,
  queueMetricsBackfill,
  queueBulkOperation,
  queueRuleEngine,
  queueRuleExecution,
  queueAiAnalysis,
  queueSpSync,
  queueRankCheck,
  startWorkers,
  stopWorkers,
  QUEUES,
};
