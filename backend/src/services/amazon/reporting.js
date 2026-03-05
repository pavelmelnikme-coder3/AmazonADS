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
// Map our internal types to Amazon's v3 reportType strings
const REPORT_CONFIGS = {
  SP: {
    campaign: {
      reportType: "spCampaigns",
      groupBy: ["campaign"],
      metrics: ["impressions","clicks","cost","purchases1d","purchases7d","purchases14d","purchases30d",
                "purchasesSameSku14d","sales1d","sales7d","sales14d","sales30d","unitsSoldClicks14d",
                "topOfSearchImpressionShare","placementProductPage","placementTop"],
    },
    ad_group: {
      reportType: "spAdGroups",
      groupBy: ["adGroup"],
      metrics: ["impressions","clicks","cost","purchases14d","sales14d"],
    },
    keyword: {
      reportType: "spKeywords",
      groupBy: ["keyword"],
      metrics: ["impressions","clicks","cost","purchases14d","sales14d","keywordId","keywordText","matchType"],
    },
    target: {
      reportType: "spTargets",
      groupBy: ["target"],
      metrics: ["impressions","clicks","cost","purchases14d","sales14d","targetingText","targetingType"],
    },
  },
  SB: {
    campaign: {
      reportType: "sbCampaigns",
      groupBy: ["campaign"],
      metrics: ["impressions","clicks","cost","purchases14d","sales14d","newToBrandOrders14d","newToBrandSales14d"],
    },
    keyword: {
      reportType: "sbKeywords",
      groupBy: ["keyword"],
      metrics: ["impressions","clicks","cost","purchases14d","sales14d","keywordText","matchType"],
    },
  },
  SD: {
    campaign: {
      reportType: "sdCampaigns",
      groupBy: ["campaign"],
      metrics: ["impressions","clicks","cost","purchases14d","sales14d","viewsRemarketingPurchases14d"],
    },
  },
};

// ─── Create Report Request ────────────────────────────────────────────────────
/**
 * Submit a report request to Amazon Ads v3 API.
 * Returns the reportId (Amazon's ID for polling).
 */
async function createReportRequest({ profile, campaignType, reportLevel, startDate, endDate, granularity = "DAY" }) {
  const config = REPORT_CONFIGS[campaignType]?.[reportLevel];
  if (!config) throw new Error(`Unsupported report: ${campaignType}/${reportLevel}`);

  const { connection_id, profile_id, marketplace_id, timezone } = profile;
  const baseUrl = getBaseUrl(marketplace_id);

  const accessToken = await getValidAccessToken(connection_id);

  const body = {
    name: `${campaignType}-${reportLevel}-${startDate}-${endDate}`,
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

  const response = await axios.post(
    `${baseUrl}/reporting/reports`,
    body,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Amazon-Advertising-API-ClientId": process.env.AMAZON_CLIENT_ID,
        "Amazon-Advertising-API-Scope": String(profile_id),
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );

  return response.data.reportId;
}

// ─── Poll Report Status ────────────────────────────────────────────────────────
async function pollReportStatus(profile, amazonReportId) {
  const { connection_id, profile_id, marketplace_id } = profile;
  const baseUrl = getBaseUrl(marketplace_id);
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

// ─── Ingest Report Data into fact_metrics_daily ───────────────────────────────
/**
 * Parse downloaded report rows and upsert into the fact table.
 */
async function ingestReportData({ reportRequestId, workspaceId, profileDbId, reportLevel, rows }) {
  let processed = 0;

  for (const row of rows) {
    try {
      const entityId = getEntityId(row, reportLevel);
      const date = row.date || row.startDate;

      await query(
        `INSERT INTO fact_metrics_daily
           (workspace_id, profile_id, date, entity_type, amazon_id,
            campaign_type, impressions, clicks, cost,
            sales_1d, sales_7d, sales_14d, sales_30d,
            orders_1d, orders_7d, orders_14d, orders_30d,
            units_sold, report_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (profile_id, amazon_id, entity_type, date)
         DO UPDATE SET
           impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
           cost = EXCLUDED.cost, sales_14d = EXCLUDED.sales_14d,
           orders_14d = EXCLUDED.orders_14d, units_sold = EXCLUDED.units_sold,
           report_id = EXCLUDED.report_id`,
        [
          workspaceId,
          profileDbId,
          date,
          reportLevel,
          entityId,
          row.campaignType || "SP",
          row.impressions || 0,
          row.clicks || 0,
          row.cost || 0,
          row.sales1d || 0,
          row.sales7d || 0,
          row.sales14d || 0,
          row.sales30d || 0,
          row.purchases1d || 0,
          row.purchases7d || 0,
          row.purchases14d || 0,
          row.purchases30d || 0,
          row.unitsSoldClicks14d || 0,
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

    await query(
      "UPDATE report_requests SET amazon_report_id = $1, status = 'requested', requested_at = NOW() WHERE id = $2",
      [amazonReportId, requestId]
    );

    // 3. Poll until complete (max 10 min)
    const maxWaitMs = 10 * 60 * 1000;
    const pollIntervalMs = 10000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      await sleep(pollIntervalMs);

      const statusData = await pollReportStatus(profileDbRecord, amazonReportId);
      logger.debug("Report poll", { requestId, amazonReportId, status: statusData.status });

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
function getBaseUrl(marketplaceId) {
  const MARKETPLACE_REGION = require("./adsClient").MARKETPLACE_REGION || {};
  // Default to NA
  return process.env.AMAZON_ADS_API_URL || "https://advertising-api.amazon.com";
}

function getEntityId(row, level) {
  const idFields = {
    campaign: "campaignId",
    ad_group: "adGroupId",
    keyword: "keywordId",
    target: "targetId",
  };
  return String(row[idFields[level]] || row.campaignId || "unknown");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  createReportRequest,
  pollReportStatus,
  downloadReport,
  ingestReportData,
  runReportingPipeline,
  REPORT_CONFIGS,
};
