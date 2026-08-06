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
const { executeAllDueRules } = require("../routes/rules");
const { query } = require("../db/pool");
const { searchBusinesses } = require("../services/leadFinder/overpass");
const { persistResults } = require("../services/leadFinder/persistResults");
const { MAX_RESULTS_PER_SEARCH } = require("../services/leadFinder/tiles");
const { filterByPolygon } = require("../services/leadFinder/geofilter");

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
  PRODUCT_META:     "product-meta-sync",
  WAWI_SYNC:        "wawi-sync",
  EMAIL_DISPATCH:   "email-dispatch",
  LEAD_FINDER_SEARCH: "lead-finder-search",
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

// Amazon's report-creation throttle is a burst window that can stay closed for many
// minutes — SB especially. createReportRequest already retries in-request (15→30→60→120s,
// honouring Retry-After), but the shared 5s/10s job backoff lands every job-level retry
// inside that same window, so all attempts burn out together and the day's report is lost.
// A lost report is a real data gap: 2026-08-05 ended up with no SB data at all and only
// 1 of 3 SD campaigns. Retry on a scale that outlasts the window instead — ~10, 30 and
// 70 minutes after the first failure, still finishing well within the day.
const REPORT_JOB_OPTIONS = {
  attempts: 4,
  backoff: { type: "exponential", delay: 10 * 60 * 1000 },
};

async function queueReportPipeline(profileId, campaignType, reportLevel, startDate, endDate) {
  const queue = getQueue(QUEUES.REPORT);
  return queue.add(
    "run",
    { profileId, campaignType, reportLevel, startDate, endDate },
    REPORT_JOB_OPTIONS
  );
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
  // deduplication (not jobId): prevents duplicate jobs while a job is waiting/active,
  // but the dedup key is automatically deleted after completion — allowing the next
  // hourly cron tick to queue a fresh job. Using a static jobId caused BullMQ to
  // silently drop all subsequent adds once the first completed job was still in Redis.
  const dedupId = ruleId ? `rule_${ruleId}_${workspaceId}` : `workspace_${workspaceId}`;
  return queue.add("execute", { workspaceId, ruleId }, { deduplication: { id: dedupId } });
}

async function queueRankCheck(workspaceId) {
  const queue = getQueue(QUEUES.RANK_CHECK);
  // Day-scoped jobId: dedupes within a single UTC day (so the cron + a manual
  // trigger on the same day don't run twice) but lets each new day re-queue.
  // A static jobId like `rank_${workspaceId}` was being silently dropped by
  // BullMQ on every subsequent day, leaving the rank-history chart with only
  // the few days where the queue was cleared (restart / removeOnComplete window).
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const jobId = `rank_${workspaceId}_${day}`;
  return queue.add("check", { workspaceId }, { jobId });
}

async function queueWawiSync(workspaceId, opts = {}) {
  const queue = getQueue(QUEUES.WAWI_SYNC);
  // Singleton per workspace: a Wawi full sync is long-running; the cron and a manual
  // trigger must coalesce into ONE job (BullMQ deduplication API — not a static jobId,
  // which silently drops jobs after completion). attempts:1 — never auto-retry a partial
  // sync into a competing second run; the next scheduled run picks up where cursors left off.
  return queue.add("wawi-sync", { workspaceId, ...opts },
    { priority: 5, attempts: 1, deduplication: { id: `wawi-sync-${workspaceId}` } });
}

async function queueProductMetaSync(workspaceId) {
  const queue = getQueue(QUEUES.PRODUCT_META);
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const jobId = `meta_${workspaceId}_${day}`;
  return queue.add("sync", { workspaceId }, { jobId });
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

async function queueLeadFinderSearch(searchId, workspaceId, tiles, businessQuery, polygon) {
  const queue = getQueue(QUEUES.LEAD_FINDER_SEARCH);
  return queue.add("tiled-search", { searchId, workspaceId, tiles, businessQuery, polygon });
}

// Prepare a marketing campaign (create per-(campaign,contact) send rows, flip to 'sending')
// then kick an immediate drip. Actual sending is budget-gated by dispatch.dripSend() and
// continued day-by-day by the drip cron — this keeps us under the provider's daily cap
// (Brevo free = 300/day account-wide) instead of firing all recipients at once.
async function queueEmailCampaign(campaignId) {
  const { prepareCampaign, dripSend } = require("../services/email/dispatch");
  const { total } = await prepareCampaign(campaignId);
  // Fire-and-forget: send today's budget worth now; the cron picks up the rest each day.
  dripSend().catch((e) => logger.warn("Immediate drip after send failed", { campaignId, error: e.message }));
  return { total };
}

// ─── Workers ──────────────────────────────────────────────────────────────────
let workers = [];

// A sweep whose worker died — process restart, container kill, BullMQ giving up after
// repeated stalls — leaves its sp_sync_log row 'running' with no completed_at, forever.
// Nothing ever reconciles them: 22 such rows had accumulated between 2026-04-27 and
// 2026-07-31. They are mostly cosmetic, but any UI or endpoint that keys off "is a sync
// running" reads them as live work and can latch on a dead row. A worker start is exactly
// the moment the previous process's in-flight rows are known to be dead.
async function closeAbandonedSyncRuns() {
  try {
    const { rows } = await query(
      `UPDATE sp_sync_log
          SET status='failed', completed_at=NOW(),
              error_message=COALESCE(error_message, 'worker did not finish; closed on startup')
        WHERE status='running' AND started_at < NOW() - INTERVAL '6 hours'
        RETURNING id`
    );
    if (rows.length) {
      logger.warn("Closed abandoned sp_sync_log runs on startup", { count: rows.length });
    }
  } catch (err) {
    // Never block worker startup on housekeeping.
    logger.warn("Could not close abandoned sync runs", { error: err.message });
  }
}

async function startWorkers() {
  await closeAbandonedSyncRuns();
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
        const result = await executeAllDueRules(workspaceId);
        logger.info("Rule execution completed", { workspaceId, rules_executed: result.rules_executed });
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

  const { syncBsr, syncInventory, syncOrders, syncFinancials, syncPricing, syncListingHealth } = require("../services/amazon/spSync");
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
          if (type === "listing_health") results.listing_health = await syncListingHealth(workspaceId, marketplaceId, refreshToken);
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

  const { scrapeRank, scrapeWorkspaceRanks } = require("../services/amazon/rankScraper");
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
      const needsScraper = [];

      for (const kw of group.keywords) {
        const result = rankMap.get(kw.keyword) || { position: null, page: null, found: false, blocked: false };
        if (result.found) {
          await query(
            `INSERT INTO keyword_rank_snapshots (tracked_keyword_id, position, page, found, blocked) VALUES ($1, $2, $3, $4, $5)`,
            [kw.id, result.position, result.page, result.found, result.blocked]
          );
          found++;
        } else {
          needsScraper.push(kw);
        }
      }

      // Fall back to scraper for keywords JS doesn't have in its top-200
      if (needsScraper.length > 0) {
        logger.info("Rank cron: JS not found, falling back to scraper", {
          asin: group.asin, count: needsScraper.length,
          keywords: needsScraper.map(k => k.keyword),
        });
        for (let i = 0; i < needsScraper.length; i++) {
          const kw = needsScraper[i];
          const result = await scrapeRank(kw.asin, kw.keyword, kw.marketplace_id);
          await query(
            `INSERT INTO keyword_rank_snapshots (tracked_keyword_id, position, page, found, blocked) VALUES ($1, $2, $3, $4, $5)`,
            [kw.id, result.position, result.page, result.found, result.blocked]
          );
          if (result.found) found++;
          if (result.blocked) {
            logger.warn("Rank cron: scraper blocked during fallback — stopping", { asin: kw.asin });
            for (let j = i + 1; j < needsScraper.length; j++) {
              const rem = needsScraper[j];
              await query(
                `INSERT INTO keyword_rank_snapshots (tracked_keyword_id, position, page, found, blocked) VALUES ($1, $2, $3, $4, $5)`,
                [rem.id, null, null, false, false]
              );
            }
            break;
          }
          if (i < needsScraper.length - 1) await new Promise(r => setTimeout(r, 3000));
        }
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

  const { syncProductsMeta } = require("../services/amazon/rankScraper");
  const productMetaWorker = new Worker(
    QUEUES.PRODUCT_META,
    async (job) => {
      const { workspaceId } = job.data;
      logger.info("Product meta sync started", { workspaceId });
      const result = await syncProductsMeta(workspaceId, { query });
      logger.info("Product meta sync done", { workspaceId, ...result });
      return result;
    },
    { connection: createRedisConnection(), concurrency: 1 }
  );
  productMetaWorker.on("failed", (job, err) => {
    logger.error("Product meta worker failed", { jobId: job?.id, error: err.message });
  });

  const { syncAll: wawiSyncAll } = require("../services/wawi/sync");
  const wawiSyncWorker = new Worker(
    QUEUES.WAWI_SYNC,
    async (job) => {
      const { workspaceId, full = false } = job.data;
      logger.info("Wawi sync started", { workspaceId, full });
      const result = await wawiSyncAll(workspaceId, { full });
      logger.info("Wawi sync done", { workspaceId, result });
      return result;
    },
    { connection: createRedisConnection(), concurrency: 1 }
  );
  wawiSyncWorker.on("failed", (job, err) => {
    logger.error("Wawi sync worker failed", { jobId: job?.id, error: err.message });
  });

  // Marketing email dispatch. Batch size = SES_MAX_SEND_RATE; limiter caps at 1 batch/sec
  // → ~SES_MAX_SEND_RATE messages/sec, staying under the SES account send rate.
  const { processBatch } = require("../services/email/dispatch");
  const emailDispatchWorker = new Worker(
    QUEUES.EMAIL_DISPATCH,
    async (job) => {
      const r = await processBatch(job.data);
      logger.info("Email batch sent", { campaignId: job.data.campaignId, ...r });
      return r;
    },
    { connection: createRedisConnection(), concurrency: 1, limiter: { max: 1, duration: 1000 } }
  );
  emailDispatchWorker.on("failed", (job, err) => {
    logger.error("Email dispatch worker failed", { jobId: job?.id, error: err.message });
  });

  // Lead Finder country-scale search: a whole-country bbox got split into ~1°x1° tiles
  // (routes/leadFinder.js) because a broad-word regex tag-scan over that much area blows past
  // Overpass's own query timeout. Processed one tile at a time (concurrency:1 — same rationale
  // as report-pipeline: don't hammer a shared free public API with concurrent large queries).
  const leadFinderSearchWorker = new Worker(
    QUEUES.LEAD_FINDER_SEARCH,
    async (job) => {
      const { searchId, workspaceId, tiles, businessQuery, polygon } = job.data;
      logger.info("Lead finder tiled search started", { searchId, tileCount: tiles.length });

      let currentTotal = 0;
      let tilesDone = 0;
      let truncated = false;

      for (const tile of tiles) {
        const { rows: [row] } = await query(`SELECT cancel_requested FROM lead_searches WHERE id = $1`, [searchId]);
        if (!row) break; // search row gone (deleted workspace/search) — nothing left to update
        if (row.cancel_requested) {
          await query(`UPDATE lead_searches SET status = 'cancelled' WHERE id = $1`, [searchId]);
          logger.info("Lead finder tiled search cancelled", { searchId, tilesDone });
          return;
        }

        const remaining = MAX_RESULTS_PER_SEARCH - currentTotal;
        if (remaining <= 0) { truncated = true; break; }

        try {
          const rawBusinesses = await searchBusinesses({ bbox: tile, query: businessQuery, limit: remaining + 1 });
          // Tile bboxes are rectangles too — a tile straddling the real border (e.g. the
          // Rhine valley near France) can still return foreign-territory matches; filter
          // against the region's actual polygon boundary, not just its bounding rectangle.
          const businesses = filterByPolygon(rawBusinesses, polygon);
          const capped = businesses.length > remaining;
          const toInsert = capped ? businesses.slice(0, remaining) : businesses;
          if (capped) truncated = true;
          const inserted = await persistResults(searchId, workspaceId, toInsert);
          currentTotal += inserted.length;
        } catch (e) {
          // One tile timing out (or Overpass being briefly overloaded) shouldn't kill the
          // whole country search — partial coverage beats aborting entirely.
          logger.warn("Lead finder tile failed, skipping", { searchId, tile, error: e.message });
        }

        tilesDone++;
        await query(
          `UPDATE lead_searches SET tiles_done = $1, result_count = $2, truncated = $3 WHERE id = $4`,
          [tilesDone, currentTotal, truncated, searchId]
        );
        await job.updateProgress(Math.round((tilesDone / tiles.length) * 100));

        if (truncated) break;
        // Polite pacing between tiles — same spirit as the scrape batch delay (routes/leadFinder.js),
        // avoids hammering the free public Overpass instance with back-to-back large-area queries.
        await new Promise((r) => setTimeout(r, 1500));
      }

      // Always re-persist truncated/result_count here too — the "remaining <= 0" branch above
      // can set `truncated = true` in JS and `break` before the per-tile UPDATE runs (that
      // check fires at the *top* of an iteration, before any DB write in that iteration), so
      // relying solely on the last per-tile write would silently leave truncated=false in a
      // hit-the-cap-exactly case.
      await query(
        `UPDATE lead_searches SET status = 'completed', tiles_done = $1, result_count = $2, truncated = $3
         WHERE id = $4 AND status = 'running'`,
        [tilesDone, currentTotal, truncated, searchId]
      );
      logger.info("Lead finder tiled search completed", { searchId, tilesDone, currentTotal, truncated });
    },
    { connection: createRedisConnection(), concurrency: 1 }
  );
  leadFinderSearchWorker.on("failed", (job, err) => {
    logger.error("Lead finder tiled search failed", { jobId: job?.id, error: err.message });
    if (job?.data?.searchId) {
      query(`UPDATE lead_searches SET status = 'failed', error_message = $1 WHERE id = $2`,
        [err.message, job.data.searchId]).catch(() => {});
    }
  });

  workers = [syncWorker, reportWorker, backfillWorker, ruleEngineWorker, ruleExecutionWorker, aiWorker, spSyncWorker, rankCheckWorker, productMetaWorker, wawiSyncWorker, emailDispatchWorker, leadFinderSearchWorker];
  logger.info("Workers started", { queues: Object.values(QUEUES) });

  // Mark stale processing/requested DB records as failed (left over from previous restarts)
  await query(
    `UPDATE report_requests SET status = 'failed', error_message = 'Stale: interrupted by server restart', updated_at = NOW()
     WHERE status IN ('processing', 'requested') AND updated_at < NOW() - INTERVAL '2 hours'`
  ).catch(e => logger.warn("Stale report cleanup failed", { error: e.message }));

  // Purge expired trash items daily
  setInterval(async () => {
    const { rowCount } = await query("DELETE FROM trash WHERE expires_at <= NOW()").catch(() => ({ rowCount: 0 }));
    if (rowCount) logger.info("Trash purge: removed expired items", { count: rowCount });
  }, 24 * 60 * 60 * 1000);
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
  queueProductMetaSync,
  queueWawiSync,
  queueEmailCampaign,
  queueLeadFinderSearch,
  startWorkers,
  stopWorkers,
  closeAbandonedSyncRuns,
  QUEUES,
  // Exposed for tests — the report backoff must stay on a throttle-window scale.
  REPORT_JOB_OPTIONS,
};
