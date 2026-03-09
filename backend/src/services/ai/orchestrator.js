/**
 * AI Orchestrator — generates actionable Amazon Ads recommendations
 * using Claude AI (Anthropic API) based on last 30 days of metrics.
 */

const Anthropic = require("@anthropic-ai/sdk");
const { v4: uuidv4 } = require("uuid");
const { query } = require("../../db/pool");
const logger = require("../../config/logger");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LANGUAGE_INSTRUCTIONS = {
  ru: "Отвечай ТОЛЬКО на русском языке. Все поля title, rationale, expected_effect должны быть на русском.",
  de: "Antworte NUR auf Deutsch. Alle Felder title, rationale, expected_effect müssen auf Deutsch sein.",
  en: "Respond in English.",
};

function buildSystemPrompt(locale) {
  const langInstruction = LANGUAGE_INSTRUCTIONS[locale] || LANGUAGE_INSTRUCTIONS.en;
  return `You are an expert Amazon Ads optimization AI. Analyze campaign performance data and generate specific, actionable recommendations. Focus on: bid adjustments, budget reallocations, campaign state changes, and targeting improvements.
Always respond with valid JSON only — no markdown, no explanation outside JSON.

IMPORTANT LANGUAGE REQUIREMENT: ${langInstruction}`;
}

// ─── Main entry point ─────────────────────────────────────────────────────────
async function generateRecommendations(workspaceId, profileDbId, locale = "en") {
  logger.info("AI Orchestrator: starting analysis", { workspaceId, profileDbId, locale });

  // 1. Pull last 30 days of campaign metrics
  const profileCondition = profileDbId ? "AND c.profile_id = $2" : "";
  const params = profileDbId ? [workspaceId, profileDbId] : [workspaceId];

  const { rows: campaignMetrics } = await query(
    `SELECT
       c.id, c.amazon_campaign_id, c.name, c.campaign_type, c.state,
       c.daily_budget, c.bidding_strategy,
       COALESCE(SUM(f.impressions), 0) as impressions,
       COALESCE(SUM(f.clicks), 0) as clicks,
       COALESCE(SUM(f.cost), 0) as cost,
       COALESCE(SUM(f.sales_14d), 0) as sales,
       COALESCE(SUM(f.orders_14d), 0) as orders,
       AVG(f.acos_14d) as acos,
       AVG(f.roas_14d) as roas,
       AVG(f.ctr) as ctr,
       AVG(f.cpc) as cpc
     FROM campaigns c
     LEFT JOIN fact_metrics_daily f
       ON f.amazon_id = c.amazon_campaign_id
       AND f.workspace_id = c.workspace_id
       AND f.entity_type = 'campaign'
       AND f.date >= NOW() - INTERVAL '30 days'
     WHERE c.workspace_id = $1 ${profileCondition}
     GROUP BY c.id, c.amazon_campaign_id, c.name, c.campaign_type, c.state, c.daily_budget, c.bidding_strategy
     ORDER BY COALESCE(SUM(f.cost), 0) DESC
     LIMIT 50`,
    params
  );

  if (!campaignMetrics.length) {
    logger.info("AI Orchestrator: no campaign data found, skipping", { workspaceId });
    return [];
  }

  // 2. Build context snapshot
  const context = buildContextSnapshot(campaignMetrics);

  // 3. Call Claude API
  const recommendations = await callClaude(context, campaignMetrics, locale);

  if (!recommendations.length) return [];

  // 4. Save recommendations to DB
  const runId = uuidv4();
  const saved = [];

  for (const rec of recommendations) {
    try {
      const { rows: [row] } = await query(
        `INSERT INTO ai_recommendations
           (workspace_id, run_id, type, title, rationale, expected_effect,
            risk_level, actions, context_snapshot, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', NOW() + INTERVAL '7 days')
         RETURNING *`,
        [
          workspaceId,
          runId,
          rec.type,
          rec.title,
          rec.rationale,
          rec.expected_effect || null,
          rec.risk_level || "medium",
          JSON.stringify(rec.actions || []),
          JSON.stringify(context.summary),
        ]
      );
      saved.push(row);
    } catch (err) {
      logger.warn("AI Orchestrator: failed to save recommendation", { error: err.message, rec: rec.title });
    }
  }

  logger.info("AI Orchestrator: recommendations saved", { workspaceId, runId, count: saved.length });
  return saved;
}

// ─── Build context snapshot ───────────────────────────────────────────────────
function buildContextSnapshot(campaigns) {
  const totalSpend  = campaigns.reduce((s, c) => s + parseFloat(c.cost || 0), 0);
  const totalSales  = campaigns.reduce((s, c) => s + parseFloat(c.sales || 0), 0);
  const avgAcos     = totalSales > 0 ? (totalSpend / totalSales * 100) : null;
  const avgRoas     = totalSpend > 0 ? (totalSales / totalSpend) : null;

  const active     = campaigns.filter(c => c.state === "enabled");
  const highAcos   = active.filter(c => parseFloat(c.acos || 0) > 30).slice(0, 10);
  const lowRoas    = active.filter(c => c.cost > 0 && parseFloat(c.roas || 0) < 2).slice(0, 10);
  const topSpend   = campaigns.slice(0, 20);
  const zeroCost   = active.filter(c => parseFloat(c.cost || 0) === 0).slice(0, 5);

  const summary = {
    total_campaigns: campaigns.length,
    active_campaigns: active.length,
    total_spend_30d: totalSpend.toFixed(2),
    total_sales_30d: totalSales.toFixed(2),
    avg_acos: avgAcos ? avgAcos.toFixed(2) : null,
    avg_roas: avgRoas ? avgRoas.toFixed(2) : null,
  };

  return {
    summary,
    top_by_spend: topSpend.map(formatCampaign),
    high_acos: highAcos.map(formatCampaign),
    low_roas: lowRoas.map(formatCampaign),
    zero_spend: zeroCost.map(formatCampaign),
  };
}

function formatCampaign(c) {
  return {
    id: c.id,
    amazon_id: c.amazon_campaign_id,
    name: c.name,
    type: c.campaign_type,
    state: c.state,
    daily_budget: parseFloat(c.daily_budget || 0).toFixed(2),
    impressions: parseInt(c.impressions || 0),
    clicks: parseInt(c.clicks || 0),
    cost: parseFloat(c.cost || 0).toFixed(2),
    sales: parseFloat(c.sales || 0).toFixed(2),
    orders: parseInt(c.orders || 0),
    acos: c.acos ? parseFloat(c.acos).toFixed(2) : null,
    roas: c.roas ? parseFloat(c.roas).toFixed(2) : null,
    ctr: c.ctr ? parseFloat(c.ctr).toFixed(4) : null,
    cpc: c.cpc ? parseFloat(c.cpc).toFixed(4) : null,
    bidding_strategy: c.bidding_strategy,
  };
}

// ─── Call Claude API ──────────────────────────────────────────────────────────
async function callClaude(context, rawCampaigns, locale = "en") {
  const userPrompt = `Analyze this Amazon Ads data and generate 5-10 actionable recommendations:

${JSON.stringify(context, null, 2)}

Return a JSON array of recommendations. Each item must have:
{
  "type": "bid_increase"|"bid_decrease"|"budget_increase"|"budget_decrease"|"pause_campaign"|"enable_campaign"|"add_negative_keyword"|"change_bidding_strategy",
  "title": "short actionable title",
  "rationale": "specific reasoning with numbers from the data",
  "expected_effect": "projected improvement",
  "risk_level": "low"|"medium"|"high",
  "actions": [{
    "action_type": "string matching type above",
    "entity_type": "campaign"|"keyword"|"target",
    "entity_id": "DB UUID from the id field",
    "amazon_id": "amazon_campaign_id value",
    "params": { "field": "value" }
  }]
}

Use the exact "id" values from the data as entity_id. Return ONLY the JSON array, no other text.`;

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [{ role: "user", content: userPrompt }],
      system: buildSystemPrompt(locale),
    });

    const content = message.content[0]?.text || "";
    logger.info("AI Orchestrator: Claude response received", { inputTokens: message.usage?.input_tokens, outputTokens: message.usage?.output_tokens });

    // Strip any accidental markdown fences
    const clean = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(clean);

    if (!Array.isArray(parsed)) {
      logger.warn("AI Orchestrator: Claude returned non-array response");
      return [];
    }

    return parsed;
  } catch (err) {
    logger.error("AI Orchestrator: Claude API call failed", { error: err.message });
    return [];
  }
}

module.exports = { generateRecommendations };
