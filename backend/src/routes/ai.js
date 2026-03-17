/**
 * AI Assistant Routes — Claude Sonnet integration
 * GET    /ai/settings
 * PATCH  /ai/settings
 * GET    /ai/recommendations
 * POST   /ai/analyze          — run analysis with optional custom prompt + scope
 * POST   /ai/recommendations/:id/apply
 * POST   /ai/recommendations/:id/dismiss
 * POST   /ai/recommendations/:id/preview
 */

const express = require("express");
const router = express.Router();
const axios = require("axios");
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const { writeAudit } = require("./audit");
const logger = require("../config/logger");

router.use(requireAuth, requireWorkspace);

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

// ── Helper: call Claude API ──────────────────────────────────────────────────
async function callClaude(systemPrompt, userMessage, maxTokens = 4000) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured in .env");

  const response = await axios.post(
    ANTHROPIC_API_URL,
    {
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    },
    {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      timeout: 60000,
    }
  );

  return response.data.content[0].text;
}

// ── Helper: build system prompt with business context ───────────────────────
function buildSystemPrompt(settings, lang = "ru") {
  const langInstructions = {
    ru: "Отвечай на русском языке.",
    en: "Reply in English.",
    de: "Antworte auf Deutsch.",
  };

  let ctx = `You are an expert Amazon Ads performance analyst. ${langInstructions[lang] || langInstructions.ru}

Your task: analyze Amazon Ads campaign data and return actionable recommendations in strict JSON format.

BUSINESS CONTEXT (always factor these into recommendations):`;

  if (settings) {
    if (settings.target_acos)    ctx += `\n- Target ACOS: ${settings.target_acos}%`;
    if (settings.max_acos)       ctx += `\n- Max acceptable ACOS: ${settings.max_acos}%`;
    if (settings.target_roas)    ctx += `\n- Target ROAS: ${settings.target_roas}x`;
    if (settings.min_roas)       ctx += `\n- Minimum ROAS: ${settings.min_roas}x`;
    if (settings.target_margin)  ctx += `\n- Business margin: ${settings.target_margin}%`;
    if (settings.monthly_budget) ctx += `\n- Monthly ad budget: €${settings.monthly_budget}`;
    if (settings.business_notes) ctx += `\n- Business notes: ${settings.business_notes}`;
  } else {
    ctx += "\n- No business context configured (use general best practices)";
  }

  ctx += `

RESPONSE FORMAT — return ONLY a valid JSON array, no markdown, no extra text:
[
  {
    "type": "bid_adjustment|budget_increase|budget_decrease|campaign_pause|keyword_add|keyword_pause|targeting_optimization|other",
    "title": "Short action title (max 80 chars)",
    "rationale": "Why this matters, citing specific numbers from the data",
    "expected_effect": "Expected outcome if applied",
    "risk_level": "low|medium|high",
    "priority": 1,
    "actions": [
      {
        "action_type": "adjust_bid|adjust_budget|pause|enable|add_keyword",
        "entity_type": "campaign|ad_group|keyword|target",
        "entity_id": "id from data or null",
        "entity_name": "human readable name",
        "params": { "field": "value" }
      }
    ]
  }
]

Rules:
- Return 3-8 recommendations max, ordered by priority (1 = most urgent)
- Be specific: cite exact campaign names, ACOS values, spend amounts from the data
- Only recommend actions that are clearly supported by the data
- If no issues found, return a single recommendation of type "other" with positive feedback`;

  return ctx;
}

// ── GET /ai/settings ─────────────────────────────────────────────────────────
router.get("/settings", async (req, res, next) => {
  try {
    const { rows: [settings] } = await query(
      "SELECT * FROM ai_workspace_settings WHERE workspace_id = $1",
      [req.workspaceId]
    );
    res.json(settings || null);
  } catch (err) { next(err); }
});

// ── PATCH /ai/settings ───────────────────────────────────────────────────────
router.patch("/settings", async (req, res, next) => {
  try {
    const {
      target_acos, max_acos, target_roas, min_roas,
      target_margin, monthly_budget, business_notes, response_language
    } = req.body;

    const { rows: [settings] } = await query(
      `INSERT INTO ai_workspace_settings
         (workspace_id, target_acos, max_acos, target_roas, min_roas,
          target_margin, monthly_budget, business_notes, response_language)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (workspace_id) DO UPDATE SET
         target_acos=$2, max_acos=$3, target_roas=$4, min_roas=$5,
         target_margin=$6, monthly_budget=$7, business_notes=$8,
         response_language=$9, updated_at=NOW()
       RETURNING *`,
      [req.workspaceId, target_acos, max_acos, target_roas, min_roas,
       target_margin, monthly_budget, business_notes, response_language || "ru"]
    );
    res.json(settings);
  } catch (err) { next(err); }
});

// ── GET /ai/recommendations ──────────────────────────────────────────────────
router.get("/recommendations", async (req, res, next) => {
  try {
    const { status, limit = 50 } = req.query;
    const conditions = ["workspace_id = $1", "expires_at > NOW()"];
    const params = [req.workspaceId];
    let pi = 2;

    if (status && status !== "all") {
      conditions.push(`status = $${pi++}`);
      params.push(status);
    }

    const { rows } = await query(
      `SELECT * FROM ai_recommendations
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${pi}`,
      [...params, parseInt(limit)]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /ai/analyze ─────────────────────────────────────────────────────────
router.post("/analyze", async (req, res, next) => {
  try {
    const { prompt = "", startDate, endDate, scope = "all" } = req.body;

    const end   = endDate   || new Date().toISOString().split("T")[0];
    const start = startDate || new Date(Date.now() - 14 * 86400000).toISOString().split("T")[0];

    // 1. Load business context settings
    const { rows: [settings] } = await query(
      "SELECT * FROM ai_workspace_settings WHERE workspace_id = $1",
      [req.workspaceId]
    );
    const lang = settings?.response_language || "ru";

    // 2. Load campaign metrics
    const params = [req.workspaceId, start, end];
    let scopeCondition = "";
    if (scope && scope !== "all") {
      params.push(scope);
      scopeCondition = `AND c.campaign_type = $${params.length}`;
    }

    const { rows: campaignData } = await query(
      `SELECT
         c.id, c.name, c.campaign_type, c.state, c.daily_budget,
         ROUND(SUM(m.cost)::numeric, 2)        as spend,
         ROUND(SUM(m.sales_14d)::numeric, 2)   as sales,
         SUM(m.clicks)                          as clicks,
         SUM(m.impressions)                     as impressions,
         SUM(m.orders_14d)                      as orders,
         ROUND(CASE WHEN SUM(m.sales_14d)>0
           THEN SUM(m.cost)/SUM(m.sales_14d)*100 END::numeric, 2) as acos,
         ROUND(CASE WHEN SUM(m.cost)>0
           THEN SUM(m.sales_14d)/SUM(m.cost) END::numeric, 2)     as roas,
         ROUND(CASE WHEN SUM(m.impressions)>0
           THEN SUM(m.clicks)::numeric/SUM(m.impressions)*100 END::numeric, 4) as ctr,
         ROUND(CASE WHEN SUM(m.clicks)>0
           THEN SUM(m.cost)/SUM(m.clicks) END::numeric, 4)        as cpc
       FROM campaigns c
       JOIN fact_metrics_daily m ON m.entity_id = c.id AND m.entity_type = 'campaign'
       WHERE c.workspace_id = $1
         AND m.date BETWEEN $2 AND $3
         ${scopeCondition}
       GROUP BY c.id, c.name, c.campaign_type, c.state, c.daily_budget
       HAVING SUM(m.cost) > 0 OR SUM(m.impressions) > 0
       ORDER BY SUM(m.cost) DESC
       LIMIT 50`,
      params
    );

    // 3. Load top keywords
    const { rows: keywordData } = await query(
      `SELECT
         k.id, k.keyword_text, k.match_type, k.state, k.bid,
         c.name as campaign_name,
         ROUND(SUM(m.cost)::numeric, 2)      as spend,
         ROUND(SUM(m.sales_14d)::numeric, 2) as sales,
         SUM(m.clicks)                        as clicks,
         ROUND(CASE WHEN SUM(m.sales_14d)>0
           THEN SUM(m.cost)/SUM(m.sales_14d)*100 END::numeric, 2) as acos
       FROM keywords k
       JOIN campaigns c ON k.campaign_id = c.id
       JOIN fact_metrics_daily m ON m.entity_id = k.id AND m.entity_type = 'keyword'
       WHERE c.workspace_id = $1
         AND m.date BETWEEN $2 AND $3
         AND k.state = 'enabled'
       GROUP BY k.id, k.keyword_text, k.match_type, k.state, k.bid, c.name
       HAVING SUM(m.cost) > 1
       ORDER BY SUM(m.cost) DESC
       LIMIT 30`,
      [req.workspaceId, start, end]
    );

    // 4. Summary stats
    const totalSpend  = campaignData.reduce((s, c) => s + parseFloat(c.spend || 0), 0);
    const totalSales  = campaignData.reduce((s, c) => s + parseFloat(c.sales || 0), 0);
    const totalOrders = campaignData.reduce((s, c) => s + parseInt(c.orders || 0), 0);
    const overallAcos = totalSales > 0 ? (totalSpend / totalSales * 100).toFixed(1) : null;
    const overallRoas = totalSpend > 0 ? (totalSales / totalSpend).toFixed(2) : null;

    // 5. Build Claude message
    const dataSection = `
ANALYSIS PERIOD: ${start} to ${end}

ACCOUNT SUMMARY:
- Total Spend: €${totalSpend.toFixed(2)}
- Total Sales: €${totalSales.toFixed(2)}
- Total Orders: ${totalOrders}
- Overall ACOS: ${overallAcos || "N/A"}%
- Overall ROAS: ${overallRoas || "N/A"}x
- Active campaigns analyzed: ${campaignData.length}

CAMPAIGN DATA (top by spend):
${JSON.stringify(campaignData, null, 2)}

TOP KEYWORDS DATA:
${JSON.stringify(keywordData.slice(0, 20), null, 2)}`;

    const userMessage = prompt
      ? `USER REQUEST: ${prompt}\n\n${dataSection}`
      : `Please analyze the following Amazon Ads account data and provide recommendations:\n\n${dataSection}`;

    // 6. Call Claude
    const systemPrompt = buildSystemPrompt(settings, lang);
    const rawResponse = await callClaude(systemPrompt, userMessage);

    // 7. Parse response
    let recommendations = [];
    try {
      const clean = rawResponse.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      recommendations = JSON.parse(clean);
      if (!Array.isArray(recommendations)) throw new Error("Expected array");
    } catch (parseErr) {
      logger.error("AI response parse error", { error: parseErr.message, raw: rawResponse.slice(0, 200) });
      return res.status(422).json({
        error: "AI returned invalid format. Try again.",
        raw: rawResponse.slice(0, 500)
      });
    }

    // 8. Invalidate previous pending recs + save new ones
    await query(
      `UPDATE ai_recommendations
       SET status='expired', expires_at=NOW()
       WHERE workspace_id=$1 AND status='pending'`,
      [req.workspaceId]
    );

    const runId = require("crypto").randomUUID();
    const saved = [];

    for (const rec of recommendations) {
      const { rows: [saved_rec] } = await query(
        `INSERT INTO ai_recommendations
           (workspace_id, run_id, type, title, rationale, expected_effect,
            risk_level, actions, context_snapshot, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW() + INTERVAL '7 days')
         RETURNING *`,
        [
          req.workspaceId, runId,
          rec.type || "other",
          rec.title || "",
          rec.rationale || "",
          rec.expected_effect || "",
          rec.risk_level || "medium",
          JSON.stringify(rec.actions || []),
          JSON.stringify({ period: { start, end }, totalSpend, totalSales, overallAcos, prompt }),
        ]
      );
      saved.push(saved_rec);
    }

    // Update last run info
    await query(
      `INSERT INTO ai_workspace_settings (workspace_id, last_run_at, last_run_prompt)
       VALUES ($1, NOW(), $2)
       ON CONFLICT (workspace_id) DO UPDATE SET last_run_at=NOW(), last_run_prompt=$2`,
      [req.workspaceId, prompt || null]
    );

    logger.info("AI analysis complete", { workspaceId: req.workspaceId, count: saved.length, runId });

    res.json({ recommendations: saved, runId, period: { start, end } });

  } catch (err) {
    if (err.response?.status === 401) {
      return res.status(401).json({ error: "Invalid ANTHROPIC_API_KEY" });
    }
    if (err.response?.status === 429) {
      return res.status(429).json({ error: "Anthropic rate limit. Try again in a moment." });
    }
    next(err);
  }
});

// ── POST /ai/recommendations/:id/preview ─────────────────────────────────────
router.post("/recommendations/:id/preview", async (req, res, next) => {
  try {
    const { rows: [rec] } = await query(
      "SELECT * FROM ai_recommendations WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    if (!rec) return res.status(404).json({ error: "Recommendation not found" });

    const actions = typeof rec.actions === "string" ? JSON.parse(rec.actions) : rec.actions;
    const changes = [];

    for (const action of actions) {
      if (action.entity_type === "campaign" && action.entity_id) {
        const { rows: [entity] } = await query(
          "SELECT id, name, state, daily_budget, bidding_strategy FROM campaigns WHERE id = $1 AND workspace_id = $2",
          [action.entity_id, req.workspaceId]
        );
        if (entity) {
          for (const [field, newValue] of Object.entries(action.params || {})) {
            changes.push({ entity_type: "campaign", entity_id: entity.id, entity_name: entity.name, field, current_value: entity[field] ?? null, new_value: newValue });
          }
        }
      } else if (action.entity_type === "keyword" && action.entity_id) {
        const { rows: [entity] } = await query(
          "SELECT id, keyword_text, bid, state FROM keywords WHERE id = $1 AND workspace_id = $2",
          [action.entity_id, req.workspaceId]
        );
        if (entity) {
          for (const [field, newValue] of Object.entries(action.params || {})) {
            changes.push({ entity_type: "keyword", entity_id: entity.id, entity_name: entity.keyword_text, field, current_value: entity[field] ?? null, new_value: newValue });
          }
        }
      }
    }

    res.json({ changes });
  } catch (err) { next(err); }
});

// ── POST /ai/recommendations/:id/apply ───────────────────────────────────────
router.post("/recommendations/:id/apply", async (req, res, next) => {
  try {
    const { rows: [rec] } = await query(
      "SELECT * FROM ai_recommendations WHERE id=$1 AND workspace_id=$2 AND status='pending'",
      [req.params.id, req.workspaceId]
    );
    if (!rec) return res.status(404).json({ error: "Not found or already actioned" });

    const actions = typeof rec.actions === "string" ? JSON.parse(rec.actions) : rec.actions;
    const applied = [];

    for (const action of actions) {
      try {
        if (action.entity_type === "campaign" && action.entity_id) {
          const p = action.params || {};
          const sets = []; const vals = [action.entity_id, req.workspaceId]; let pi = 3;
          if (p.daily_budget !== undefined) { sets.push(`daily_budget = $${pi++}`); vals.push(parseFloat(p.daily_budget)); }
          if (p.state !== undefined)        { sets.push(`state = $${pi++}`);        vals.push(p.state); }
          if (sets.length) {
            sets.push("updated_at = NOW()");
            await query(`UPDATE campaigns SET ${sets.join(", ")} WHERE id = $1 AND workspace_id = $2`, vals);
            applied.push({ action_type: action.action_type, entity: action.entity_id });
          }
        } else if (action.entity_type === "keyword" && action.entity_id) {
          const p = action.params || {};
          if (p.bid !== undefined) {
            await query("UPDATE keywords SET bid = $1, updated_at = NOW() WHERE id = $2 AND workspace_id = $3", [parseFloat(p.bid), action.entity_id, req.workspaceId]);
            applied.push({ action_type: action.action_type, entity: action.entity_id });
          }
        }
      } catch (actionErr) {
        logger.warn("AI apply: action failed", { error: actionErr.message, action });
      }
    }

    await query(
      "UPDATE ai_recommendations SET status='applied', applied_at=NOW(), applied_by=$1 WHERE id=$2",
      [req.user.id, rec.id]
    );

    await writeAudit({
      orgId: req.orgId,
      actorId: req.user.id,
      actorName: req.user.name,
      actorType: "user",
      action: "ai.recommendation.applied",
      entityType: "ai_recommendation",
      entityId: rec.id,
      entityName: rec.title,
      afterData: { actions: applied },
      source: "ai",
    });

    res.json({ applied: true, actionsExecuted: applied.length });
  } catch (err) { next(err); }
});

// ── POST /ai/recommendations/:id/dismiss ─────────────────────────────────────
router.post("/recommendations/:id/dismiss", async (req, res, next) => {
  try {
    const { rowCount } = await query(
      "UPDATE ai_recommendations SET status='dismissed', dismissed_at=NOW() WHERE id=$1 AND workspace_id=$2 AND status='pending'",
      [req.params.id, req.workspaceId]
    );
    if (!rowCount) return res.status(404).json({ error: "Not found or already actioned" });
    res.json({ dismissed: true });
  } catch (err) { next(err); }
});

module.exports = router;
