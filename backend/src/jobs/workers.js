/**
 * BullMQ Job Queue Configuration
 * Workers: entity sync, report pipeline, bulk operations, rule engine, metrics backfill
 */

const { Queue, Worker, QueueEvents } = require("bullmq");
const { createRedisConnection } = require("../config/redis");
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
const { query } = require("../db/pool");

// ─── Queue definitions ────────────────────────────────────────────────────────
const QUEUES = {
  ENTITY_SYNC:      "entity-sync",
  REPORT:           "report-pipeline",
  BULK_OPS:         "bulk-operations",
  RULE_ENGINE:      "rule-engine",
  ALERT_CHECK:      "alert-check",
  METRICS_BACKFILL: "metrics-backfill",
  AI_ANALYSIS:      "ai-analysis",
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

async function queueAiAnalysis(workspaceId, locale = "en") {
  const queue = getQueue(QUEUES.AI_ANALYSIS);
  return queue.add("analyze", { workspaceId, locale }, { priority: 5 });
}

async function queueRuleEngine(workspaceId) {
  const queue = getQueue(QUEUES.RULE_ENGINE);
  return queue.add("evaluate", { workspaceId });
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

      // ── Keywords ──────────────────────────────────────────────────────────
      if (entityTypes.includes("keywords")) {
        await job.updateProgress(progress); progress += 10;
        const keywords = await fetchKeywords(profile);
        await syncKeywords(profile, keywords);
        results.keywords = keywords.length;
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
    { connection: createRedisConnection(), concurrency: 3 }
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
    { connection: createRedisConnection(), concurrency: 2 }
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

  // ─── Rule Engine Worker ────────────────────────────────────────────────────
  const ruleEngineWorker = new Worker(
    QUEUES.RULE_ENGINE,
    async (job) => {
      const { workspaceId } = job.data;
      logger.info("Rule engine started", { workspaceId });

      const { rows: rules } = await query(
        "SELECT * FROM rules WHERE workspace_id = $1 AND is_active = TRUE",
        [workspaceId]
      );

      const results = [];
      for (const rule of rules) {
        try {
          const conditions = typeof rule.conditions === "string" ? JSON.parse(rule.conditions) : rule.conditions;
          const actions    = typeof rule.actions === "string"    ? JSON.parse(rule.actions)    : rule.actions;
          const safety     = typeof rule.safety === "string"     ? JSON.parse(rule.safety)     : rule.safety;

          const { rows: campaigns } = await query(
            `SELECT c.id, c.name, c.state, c.daily_budget,
                    COALESCE(m.cost, 0) as spend,
                    COALESCE(m.impressions, 0) as impressions,
                    CASE WHEN SUM(m.impressions) > 0 THEN SUM(m.clicks)::numeric / SUM(m.impressions) END as ctr,
                    m.acos_14d as acos
             FROM campaigns c
             LEFT JOIN (
               SELECT amazon_id,
                      SUM(cost) as cost, SUM(impressions) as impressions,
                      CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)::numeric / SUM(impressions) END as ctr,
                      CASE WHEN SUM(sales_14d) > 0 THEN SUM(cost) / SUM(sales_14d) * 100 END as acos_14d
               FROM fact_metrics_daily
               WHERE workspace_id = $1 AND date >= NOW() - INTERVAL '7 days'
               GROUP BY amazon_id
             ) m ON m.amazon_id = c.amazon_campaign_id
             WHERE c.workspace_id = $1 AND c.state != 'archived'`,
            [workspaceId]
          );

          const condsArr = Array.isArray(conditions) ? conditions : [conditions];
          const actsArr  = Array.isArray(actions)    ? actions    : [actions];
          const matched  = campaigns.filter(c => evaluateConditions(condsArr, c));
          let actionsExecuted = 0;

          if (!rule.dry_run && matched.length > 0) {
            for (const campaign of matched) {
              for (const action of actsArr) {
                await executeRuleAction(action, campaign, safety);
                actionsExecuted++;
              }
            }
          }

          await query(
            "UPDATE rules SET last_run_at = NOW(), last_run_result = $1, updated_at = NOW() WHERE id = $2",
            [JSON.stringify({ matchCount: matched.length, actionsExecuted, dryRun: rule.dry_run }), rule.id]
          );

          results.push({ ruleId: rule.id, name: rule.name, matchCount: matched.length, actionsExecuted });
          logger.info("Rule evaluated", { ruleId: rule.id, matchCount: matched.length, actionsExecuted });
        } catch (e) {
          logger.error("Rule evaluation failed", { ruleId: rule.id, error: e.message });
        }
      }

      logger.info("Rule engine completed", { workspaceId, rules: results.length });
      return { workspaceId, rules: results.length, results };
    },
    { connection: createRedisConnection(), concurrency: 1 }
  );

  ruleEngineWorker.on("failed", (job, err) => {
    logger.error("Rule engine worker failed", { jobId: job?.id, error: err.message });
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

  workers = [syncWorker, reportWorker, backfillWorker, ruleEngineWorker, aiWorker];
  logger.info("Workers started", { queues: Object.values(QUEUES) });
}

async function stopWorkers() {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(Object.values(queues).map((q) => q.close()));
}

// ─── Rule engine helpers ──────────────────────────────────────────────────────
function evaluateConditions(conditions, campaign) {
  return conditions.every(({ type, value }) => {
    switch (type) {
      case "acos_gt":        return parseFloat(campaign.acos) > value;
      case "spend_gt":       return parseFloat(campaign.spend) > value;
      case "ctr_lt":         return parseFloat(campaign.ctr) < value;
      case "impressions_lt": return parseInt(campaign.impressions) < value;
      default: return false;
    }
  });
}

async function executeRuleAction(action, campaign, safety) {
  const { max_change_pct = 20, min_bid = 0.02, max_bid = 50 } = safety || {};
  switch (action.type) {
    case "pause_campaign":
      await query("UPDATE campaigns SET state = 'paused', updated_at = NOW() WHERE id = $1", [campaign.id]);
      break;
    case "adjust_bid_pct": {
      const pct = Math.min(Math.abs(action.value), max_change_pct) * Math.sign(action.value);
      await query(
        `UPDATE keywords SET bid = GREATEST($1, LEAST($2, bid * (1 + $3::numeric / 100))), updated_at = NOW()
         WHERE campaign_id = $4`,
        [min_bid, max_bid, pct, campaign.id]
      );
      break;
    }
    case "adjust_budget_pct": {
      const pct = Math.min(Math.abs(action.value), max_change_pct) * Math.sign(action.value);
      await query(
        "UPDATE campaigns SET daily_budget = GREATEST(0.01, daily_budget * (1 + $1::numeric / 100)), updated_at = NOW() WHERE id = $2",
        [pct, campaign.id]
      );
      break;
    }
    case "add_negative_keyword":
      logger.info("add_negative_keyword: requires API integration", { campaignId: campaign.id, keyword: action.keyword });
      break;
  }
}

module.exports = {
  getQueue,
  queueEntitySync,
  queueReportPipeline,
  queueMetricsBackfill,
  queueBulkOperation,
  queueRuleEngine,
  queueAiAnalysis,
  startWorkers,
  stopWorkers,
  QUEUES,
};
