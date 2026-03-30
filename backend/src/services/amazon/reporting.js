/**
 * Amazon Ads Reporting API v3
 *
 * Flow:
 * 1. POST /reporting/reports  → Amazon creates report, returns reportId
 * 2. GET  /reporting/reports/{id} → Poll status: IN_PROGRESS | COMPLETED | FAILED
 * 3. GET report download URL → download gzipped JSON/CSV
 * 4. Parse → upsert into fact_metrics_daily
 *
 * Docs: https://advertising.amazon.com/API/docs/en-us/reporting/v3/report-types
 */

const axios = require("axios");
const zlib = require("zlib");
const { promisify } = require("util");
const { get, post } = require("./adsClient");
const { getValidAccessToken } = require("./lwa");
const { query } = require("../../db/pool");
const logger = require("../../config/logger");

const gunzip = promisify(zlib.gunzip);
const REPORTING_BASE = "/reporting/reports";

// ─── Report Type Definitions ──────────────────────────────────────────────────
// Map our internal types to Amazon's v3 reportType strings + exact column names.
const REPORT_CONFIGS = {
  SP: {
    campaign: {
      reportType: "spCampaigns",
      groupBy: ["campaign"],
      metrics: ["campaignId","campaignName","impressions","clicks","cost",
        "purchases1d","purchases7d","purchases14d","purchases30d",
        "sales1d","sales7d","sales14d","sales30d","date"],
    },
    keyword: {
      reportType: "spKeywords",
      groupBy: ["adGroup"],
      metrics: ["keywordId","keywordText","matchType","keyword",
        "impressions","clicks","cost",
        "purchases1d","purchases7d","purchases14d","purchases30d",
        "sales1d","sales7d","sales14d","sales30d",
        "topOfSearchImpressionShare","campaignBudgetCurrencyCode","currency","date"],
    },
    target: {
      reportType: "spTargeting",
      groupBy: ["targeting"],
      metrics: ["campaignId","campaignName","adGroupId","adGroupName",
        "targeting","keywordId","keyword","keywordBid","keywordType","matchType",
        "impressions","clicks","cost",
        "purchases1d","purchases7d","purchases14d","purchases30d",
        "sales1d","sales7d","sales14d","sales30d",
        "portfolioId","campaignBudgetCurrencyCode","date"],
    },
    advertised_product: {
      reportType: "spAdvertisedProduct",
      groupBy: ["advertiser"],
      metrics: ["campaignId","campaignName","adGroupId","adGroupName",
        "advertisedAsin","advertisedSku",
        "impressions","clicks","cost",
        "purchases1d","purchases7d","purchases14d","purchases30d",
        "sales1d","sales7d","sales14d","sales30d","date"],
    },
  },
  // SB uses no time-window suffixes: purchases/sales not purchases14d/sales14d
  SB: {
    campaign: {
      reportType: "sbCampaigns",
      groupBy: ["campaign"],
      metrics: ["campaignId","campaignName","impressions","clicks","cost",
        "purchases","sales","purchasesClicks","salesClicks","unitsSold","date"],
    },
    keyword: {
      // Amazon SB v3 has no direct keyword-level report; sbSearchTerm is the equivalent
      reportType: "sbSearchTerm",
      groupBy: ["searchTerm"],
      metrics: ["searchTerm","keywordId","keywordText","matchType",
        "impressions","clicks","cost",
        "purchases","sales","purchasesClicks","salesClicks","unitsSold","date"],
    },
    ad_group: {
      reportType: "sbAdGroup",
      groupBy: ["adGroup"],
      metrics: ["adGroupId","adGroupName","campaignId","campaignName",
        "impressions","clicks","cost",
        "purchases","sales","purchasesClicks","salesClicks","unitsSold","date"],
    },
  },
  // SD uses different metric naming: no time-window suffixes (purchases/sales, not purchases14d/sales14d)
  SD: {
    campaign: {
      reportType: "sdCampaigns",
      groupBy: ["campaign"],
      metrics: ["campaignId","campaignName","impressions","clicks","cost",
        "purchases","sales","purchasesClicks","salesClicks","unitsSold","date"],
    },
    ad_group: {
      reportType: "sdAdGroup",
      groupBy: ["adGroup"],
      metrics: ["adGroupId","adGroupName","campaignId","campaignName",
        "impressions","clicks","cost",
        "purchases","sales","purchasesClicks","salesClicks","unitsSold","date"],
    },
    target: {
      reportType: "sdTargeting",
      groupBy: ["targeting"],
      // targetId and targetingType are not valid SD columns; use targetingId
      metrics: ["targetingId","targetingExpression","targetingText",
        "campaignId","campaignName","adGroupId","adGroupName",
        "impressions","clicks","cost",
        "purchases","sales","purchasesClicks","salesClicks","unitsSold","date"],
    },
  },
};

// ─── Create Report Request ────────────────────────────────────────────────────
/**
 * Submit a report request to Amazon Ads v3 API.
 * Returns the reportId (Amazon's ID for polling).
 */
async function createReportRequest({ profile, campaignType, reportLevel, startDate, endDate, granularity = "DAILY" }) {
  const config = REPORT_CONFIGS[campaignType]?.[reportLevel];
  if (!config) throw new Error(`Unsupported report: ${campaignType}/${reportLevel}`);

  const { connection_id, profile_id, marketplace_id, country_code, marketplace, timezone } = profile;
  const baseUrl = getBaseUrl(marketplace_id, country_code || marketplace);

  const accessToken = await getValidAccessToken(connection_id);

  // Unique name per request to avoid Amazon 425 "duplicate" rejections
  const uniqueSuffix = Date.now().toString(36);
  const body = {
    name: `${campaignType}-${reportLevel}-${startDate}-${endDate}-${uniqueSuffix}`,
    startDate,
    endDate,
    configuration: {
      adProduct: campaignType === "SP" ? "SPONSORED_PRODUCTS" : campaignType === "SB" ? "SPONSORED_BRANDS" : "SPONSORED_DISPLAY",
      groupBy: config.groupBy,
      columns: config.metrics,
      reportTypeId: config.reportType,
      timeUnit: granularity,                // SUMMARY or DAILY
      format: "GZIP_JSON",
    },
  };

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Amazon-Advertising-API-ClientId": process.env.AMAZON_CLIENT_ID,
    "Amazon-Advertising-API-Scope": String(profile_id),
    "Content-Type": "application/vnd.createasyncreportrequest.v3+json",
  };

  // Retry up to 3 times on 429 throttling with exponential backoff
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;
    try {
      response = await axios.post(`${baseUrl}/reporting/reports`, body, { headers, timeout: 15000 });
      return response.data.reportId;
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data?.detail || "";

      // 425: duplicate — reuse the existing reportId Amazon returned
      if (status === 425) {
        const match = detail.match(/([0-9a-f-]{36})/i);
        if (match) {
          logger.warn("Amazon report duplicate detected, reusing existing reportId", {
            existingReportId: match[1], campaignType, reportLevel,
          });
          return match[1];
        }
      }

      // 429: throttled — wait and retry
      if (status === 429 && attempt < 3) {
        const delay = attempt * 15000; // 15s, 30s
        logger.warn("Amazon report API throttled, retrying", { attempt, delayMs: delay, campaignType, reportLevel });
        await sleep(delay);
        continue;
      }

      logger.error("Amazon Reporting API error response", {
        status,
        data: JSON.stringify(err.response?.data),
        requestBody: JSON.stringify(body),
        baseUrl,
        profileId: profile_id,
        campaignType,
        reportLevel,
      });
      throw err;
    }
  }
}

// ─── Poll Report Status ────────────────────────────────────────────────────────
async function pollReportStatus(profile, amazonReportId) {
  const { connection_id, profile_id, marketplace_id, country_code, marketplace } = profile;
  const baseUrl = getBaseUrl(marketplace_id, country_code || marketplace);
  const accessToken = await getValidAccessToken(connection_id);

  const response = await axios.get(
    `${baseUrl}/reporting/reports/${amazonReportId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Amazon-Advertising-API-ClientId": process.env.AMAZON_CLIENT_ID,
        "Amazon-Advertising-API-Scope": String(profile_id),
      },
      timeout: 10000,
    }
  );

  return response.data;
  // { reportId, status: "IN_PROGRESS" | "COMPLETED" | "FAILED", url, fileSize }
}

// ─── Download and Parse Report ────────────────────────────────────────────────
async function downloadReport(downloadUrl) {
  const response = await axios.get(downloadUrl, {
    responseType: "arraybuffer",
    timeout: 60000,
  });

  const isGzip = response.headers["content-type"]?.includes("gzip") ||
                 downloadUrl.includes(".gz");

  let data;
  if (isGzip) {
    const decompressed = await gunzip(response.data);
    data = decompressed.toString("utf8");
  } else {
    data = response.data.toString("utf8");
  }

  return JSON.parse(data);
}

// ─── Resolve Amazon entity ID to local UUID ───────────────────────────────────
async function resolveEntityId(amazonId, entityType, workspaceId) {
  if (!amazonId || amazonId === "unknown") return null;
  try {
    let result;
    if (entityType === "keyword") {
      result = await query(
        "SELECT id FROM keywords WHERE amazon_keyword_id = $1 AND workspace_id = $2 LIMIT 1",
        [String(amazonId), workspaceId]
      );
    } else if (entityType === "target") {
      result = await query(
        "SELECT id FROM targets WHERE amazon_target_id = $1 AND workspace_id = $2 LIMIT 1",
        [String(amazonId), workspaceId]
      );
    } else if (entityType === "ad_group") {
      result = await query(
        "SELECT id FROM ad_groups WHERE amazon_ag_id = $1 AND workspace_id = $2 LIMIT 1",
        [String(amazonId), workspaceId]
      );
    } else if (entityType === "campaign") {
      result = await query(
        "SELECT id FROM campaigns WHERE amazon_campaign_id = $1 AND workspace_id = $2 LIMIT 1",
        [String(amazonId), workspaceId]
      );
    } else {
      return null; // advertised_product (ASIN) — no matching table
    }
    return result?.rows?.[0]?.id || null;
  } catch {
    return null;
  }
}

// ─── Ingest Report Data into fact_metrics_daily ───────────────────────────────
/**
 * Parse downloaded report rows and upsert into the fact table.
 */
async function ingestReportData({ reportRequestId, workspaceId, profileDbId, reportLevel, rows }) {
  let processed = 0;

  for (const row of rows) {
    try {
      const amazonEntityId = getEntityId(row, reportLevel);
      const entityUuid     = await resolveEntityId(amazonEntityId, reportLevel, workspaceId);
      const date = row.date || row.startDate;

      await query(
        `INSERT INTO fact_metrics_daily
           (workspace_id, profile_id, date, entity_type, entity_id, amazon_id,
            campaign_type, impressions, clicks, cost,
            sales_1d, sales_7d, sales_14d, sales_30d,
            orders_1d, orders_7d, orders_14d, orders_30d,
            units_sold, report_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (profile_id, amazon_id, entity_type, date)
         DO UPDATE SET
           impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
           cost = EXCLUDED.cost, sales_14d = EXCLUDED.sales_14d,
           orders_14d = EXCLUDED.orders_14d, units_sold = EXCLUDED.units_sold,
           report_id = EXCLUDED.report_id,
           entity_id = COALESCE(EXCLUDED.entity_id, fact_metrics_daily.entity_id)`,
        [
          workspaceId,
          profileDbId,
          date,
          reportLevel,
          entityUuid,
          amazonEntityId,
          row.campaignType || "SP",
          row.impressions || 0,
          row.clicks || 0,
          row.cost || 0,
          row.sales1d || 0,
          row.sales7d || 0,
          row.sales14d || row.sales || 0,             // SD uses 'sales' (no window suffix)
          row.sales30d || 0,
          row.purchases1d || 0,
          row.purchases7d || 0,
          row.purchases14d || row.purchases || 0,     // SD uses 'purchases' (no window suffix)
          row.purchases30d || 0,
          row.unitsSoldClicks14d || row.unitsSold || 0,  // SD uses 'unitsSold'
          reportRequestId,
        ]
      );
      processed++;
    } catch (err) {
      logger.warn("Failed to ingest report row", { error: err.message, row: JSON.stringify(row).substring(0, 100) });
    }
  }

  return processed;
}

// ─── Full report pipeline (request → poll → download → ingest) ────────────────
/**
 * Orchestrate the full async reporting cycle for a profile.
 * Intended to be called from a BullMQ worker.
 */
async function runReportingPipeline({ profileDbRecord, campaignType, reportLevel, startDate, endDate }) {
  const { id: profileDbId, workspace_id: workspaceId } = profileDbRecord;

  // 1. Create report request in our DB
  const { rows: [dbRequest] } = await query(
    `INSERT INTO report_requests
       (workspace_id, profile_id, campaign_type, report_type, date_start, date_end,
        granularity, metrics, status, triggered_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'DAY', $7, 'pending', 'scheduler')
     RETURNING id`,
    [
      workspaceId, profileDbId, campaignType, reportLevel,
      startDate, endDate,
      REPORT_CONFIGS[campaignType]?.[reportLevel]?.metrics || [],
    ]
  );

  const requestId = dbRequest.id;

  try {
    // 2. Submit to Amazon
    const amazonReportId = await createReportRequest({
      profile: profileDbRecord,
      campaignType,
      reportLevel,
      startDate,
      endDate,
    });

    logger.info("Report requested from Amazon", { requestId, amazonReportId, campaignType, reportLevel, startDate, endDate });

    await query(
      "UPDATE report_requests SET amazon_report_id = $1, status = 'requested', requested_at = NOW() WHERE id = $2",
      [amazonReportId, requestId]
    );

    // 3. Poll until complete (max 30 min — SD/SB reports can take 15–25 min on Amazon)
    const maxWaitMs = 30 * 60 * 1000;
    const pollIntervalMs = 15000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      await sleep(pollIntervalMs);

      const statusData = await pollReportStatus(profileDbRecord, amazonReportId);
      logger.info("Report poll", { requestId, amazonReportId, status: statusData.status });

      if (statusData.status === "COMPLETED") {
        // 4. Download
        const rows = await downloadReport(statusData.url);
        await query("UPDATE report_requests SET status = 'processing', updated_at = NOW() WHERE id = $1", [requestId]);

        // 5. Ingest
        const processed = await ingestReportData({ reportRequestId: requestId, workspaceId, profileDbId, reportLevel, rows });

        await query(
          "UPDATE report_requests SET status = 'completed', completed_at = NOW(), row_count = $1 WHERE id = $2",
          [processed, requestId]
        );

        logger.info("Report pipeline completed", { requestId, amazonReportId, processed });
        return { success: true, processed };
      }

      if (statusData.status === "FAILED") {
        throw new Error(`Amazon report failed: ${JSON.stringify(statusData)}`);
      }

      await query("UPDATE report_requests SET status = 'processing', updated_at = NOW() WHERE id = $1", [requestId]);
    }

    throw new Error("Report polling timed out after 10 minutes");

  } catch (err) {
    await query(
      "UPDATE report_requests SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2",
      [err.message, requestId]
    );
    logger.error("Report pipeline failed", { requestId, error: err.message });
    throw err;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const API_URLS_REPORTING = {
  NA: process.env.AMAZON_ADS_API_URL    || "https://advertising-api.amazon.com",
  EU: process.env.AMAZON_ADS_API_EU_URL || "https://advertising-api-eu.amazon.com",
  FE: process.env.AMAZON_ADS_API_FE_URL || "https://advertising-api-fe.amazon.com",
};

const MARKETPLACE_REGION_REPORTING = {
  ATVPDKIKX0DER: "NA", A2EUQ1WTGCTBG2: "NA", A1AM78C64UM0Y8: "NA",
  A1F83G8C2ARO7P: "EU", A1PA6795UKMFR9: "EU", APJ6JRA9NG5V4: "EU",
  A13V1IB3VIYZZH: "EU", A1RKKUPIHCS9HS: "EU", A17E79C6D8DWNP: "EU",
  A2VIGQ35RCS4UG: "EU", A1MNDV6DTONNN6: "EU", A2NODRKZP88ZB9: "EU",
  A39IBJ37TRP1C6: "FE", A1VC38T7YXB528: "FE", A21TJRUUN4KGV:  "FE",
};

const COUNTRY_REGION_REPORTING = {
  US: "NA", CA: "NA", MX: "NA",
  GB: "EU", UK: "EU", DE: "EU", FR: "EU", IT: "EU",
  ES: "EU", NL: "EU", SE: "EU", PL: "EU", TR: "EU", SA: "EU", AE: "EU",
  JP: "FE", AU: "FE", SG: "FE", IN: "FE",
};

function getBaseUrl(marketplaceId, countryCode) {
  const region = MARKETPLACE_REGION_REPORTING[marketplaceId]
    || COUNTRY_REGION_REPORTING[(countryCode || "").toUpperCase()]
    || "EU"; // default EU since most profiles are EU
  return API_URLS_REPORTING[region];
}

function getEntityId(row, level) {
  if (level === "target") {
    // spTargeting uses keywordId; sdTargeting uses targetingId
    return String(row.keywordId || row.targetingId || row.campaignId || "unknown");
  }
  const idFields = {
    campaign:           "campaignId",
    ad_group:           "adGroupId",
    keyword:            "keywordId",
    advertised_product: "advertisedAsin",
  };
  return String(row[idFields[level]] || row.campaignId || "unknown");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Metrics Backfill: queue all report types for a workspace ─────────────────
/**
 * Queue individual report-pipeline BullMQ jobs for all profiles × all report types.
 * dateFrom defaults to 60 days ago, dateTo to yesterday.
 * Called by the metrics-backfill worker — does NOT run reports inline, just queues them.
 *
 * @param {string} workspaceId
 * @param {Function} queueReportPipelineFn  - workers.queueReportPipeline
 * @param {string} [dateFrom]
 * @param {string} [dateTo]
 * @returns {{ profileCount, jobsQueued, dateFrom, dateTo }}
 */
async function queueMetricsBackfillJobs(workspaceId, queueReportPipelineFn, dateFrom, dateTo) {
  const toDate = dateTo || (() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toISOString().split("T")[0];
  })();
  const fromDate = dateFrom || (() => {
    const d = new Date(); d.setDate(d.getDate() - 60);
    return d.toISOString().split("T")[0];
  })();

  const { rows: profiles } = await query(
    `SELECT p.id FROM amazon_profiles p
     JOIN amazon_connections c ON c.id = p.connection_id
     WHERE p.workspace_id = $1 AND p.is_attached = TRUE AND c.status = 'active'`,
    [workspaceId]
  );

  const reportTypes = [
    ["SP", "campaign"],
    ["SP", "keyword"],
    ["SP", "target"],
    ["SP", "advertised_product"],
    ["SB", "campaign"],
    ["SB", "keyword"],
    ["SB", "ad_group"],
    ["SD", "campaign"],
    ["SD", "ad_group"],
    ["SD", "target"],
  ];

  // Amazon daily reports max date range = 31 days — split into chunks
  const MAX_DAYS = 31;
  const dateChunks = [];
  let chunkStart = new Date(fromDate);
  const endDate = new Date(toDate);
  while (chunkStart <= endDate) {
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setDate(chunkEnd.getDate() + MAX_DAYS - 1);
    if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime());
    dateChunks.push([
      chunkStart.toISOString().split("T")[0],
      chunkEnd.toISOString().split("T")[0],
    ]);
    chunkStart = new Date(chunkEnd);
    chunkStart.setDate(chunkStart.getDate() + 1);
  }

  let jobsQueued = 0;
  for (const { id: profileId } of profiles) {
    for (const [campaignType, reportLevel] of reportTypes) {
      for (const [chunkFrom, chunkTo] of dateChunks) {
        await queueReportPipelineFn(profileId, campaignType, reportLevel, chunkFrom, chunkTo);
        logger.info("Queued metrics report job", { profileId, campaignType, reportLevel, chunkFrom, chunkTo });
        jobsQueued++;
      }
    }
  }

  logger.info("Metrics backfill queued", { workspaceId, profileCount: profiles.length, jobsQueued, chunks: dateChunks.length, fromDate, toDate });
  return { profileCount: profiles.length, jobsQueued, dateFrom: fromDate, dateTo: toDate };
}

module.exports = {
  createReportRequest,
  pollReportStatus,
  downloadReport,
  ingestReportData,
  runReportingPipeline,
  queueMetricsBackfillJobs,
  REPORT_CONFIGS,
};
