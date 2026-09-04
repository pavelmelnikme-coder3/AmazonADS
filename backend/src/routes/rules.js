/**
 * Rules Engine Routes
 * GET    /rules                   — list with pagination
 * POST   /rules                   — create
 * PATCH  /rules/:id               — update
 * DELETE /rules/:id               — delete
 * POST   /rules/:id/run           — execute rule synchronously (dry_run flag)
 * GET    /rules/campaigns         — campaigns list for scope selector
 * GET    /rules/ad-groups         — ad-groups list (optionally filtered by campaignId)
 * GET    /rules/targets           — targets list for scope selector
 */

const express = require("express");
const router  = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const { writeAudit, updateAuditStatus } = require("./audit");
const { pushNegativeKeyword, pushNegativeAsin, pushNegativeTarget, pushKeywordUpdates, archiveNegativeKeyword, archiveNegativeTarget, pushCampaignUpdates, partialError, campaignApiPath } = require("../services/amazon/writeback");
const { put, post } = require("../services/amazon/adsClient");
const { normalizeKeywordText, unsupportedKeywordChars, sqlNormalizeKeywordText } = require("../services/amazon/keywordText");
const logger  = require("../config/logger");
const { getRedis } = require("../config/redis");

router.use(requireAuth, requireWorkspace);

// Ids the rule engine invents locally for a negative that has no Amazon id yet:
// "rule-…" before the write-back lands, "archived-…" once reconciliation frees a
// placeholder for re-use. Neither may be sent to Amazon as an entity id.
function isSyntheticNegId(id) {
  return !id || id.startsWith("rule-") || id.startsWith("archived-");
}

// Amazon rejections that describe the *input* rather than a temporary condition: the same
// text will be refused again tomorrow, and the day after. Re-issuing the write every run
// spends an API call and writes an audit error for nothing, so a negative whose creation
// failed this way is not retried — it is reported as skipped, with the reason, instead.
//
// Everything else (401, 429, 5xx, timeouts, connection resets — the 2026-06 access incident
// was all 401s) is treated as transient and retried on the next run.
// Duplicate errors are deliberately absent: they mean the negative *does* exist on Amazon,
// and pushNegativeKeyword/pushNegativeAsin already recover the real id from one. If that
// recovery itself fails the next run should try again.
const PERMANENT_WRITEBACK_ERROR =
  /PATTERN_NOT_MATCHED|malformedValueError|Keyword is invalid|INVALID_ARGUMENT|NOT_SUPPORTED|UNSUPPORTED/i;

function isPermanentWritebackError(message) {
  return !!message && PERMANENT_WRITEBACK_ERROR.test(String(message));
}

// Decide whether a negative this rule created should stay in place.
//
// A negative is released ONLY on evidence the term actually converts. Falling short of the
// rule's own threshold is deliberately NOT such evidence: a negated term stops receiving
// traffic, so its clicks age out of the rolling window and the count shrinks on its own.
// Releasing on that shrinking count is circular — the negative suppresses the very data used
// to judge it — and it made terms flip-flop across the threshold indefinitely. Measured over
// 30 days before this rule existed, 216 of 438 releases (49%) freed terms that had never
// produced a single order, at an average 6.6 clicks against thresholds of 6 and 8.
//
// So: zero orders → keep the negative, whatever the click count has decayed to. Once the term
// does convert, the rule's own conditions decide as before (a `orders = 0` rule stops matching,
// an `orders = 1` rule stops matching at 2, and so on).
function negativeStillJustified(metricConditions, aggregate, slices) {
  if (Number(aggregate.orders || 0) === 0) return true;
  return slices
    ? slices.some(s => evaluate(metricConditions, s))
    : evaluate(metricConditions, aggregate);
}

// ── Reconciliation hysteresis ────────────────────────────────────────────────
// Releasing a negative on a single unjustified run makes it flip: Amazon restates
// conversions into the search-term report a day or two after the fact, so `orders` moves
// 0 → 1 → 0 for the same term while the rolling window slides underneath it. Between
// 11–18.08.2026 that produced 11 add → release-next-run → re-add cycles, each letting the
// term spend again for a couple of days in between.
//
// So a release has to be confirmed: an unjustified run increments a persisted counter, a
// justified run clears it, and the negative is only released once the count reaches
// `safety.reconcile_grace_runs`. 1 restores the previous release-on-first-miss behaviour.
const RECONCILE_GRACE_RUNS_DEFAULT = 2;
const RECONCILE_TABLES = new Set(["negative_keywords", "negative_targets"]);

async function confirmReconcileRelease({ table, id, missCount, justified, graceRuns, dryRun }) {
  if (!RECONCILE_TABLES.has(table)) throw new Error(`Unexpected reconcile table: ${table}`);
  if (justified) {
    // Clear a part-way count so an unrelated miss later starts from scratch.
    if (!dryRun && Number(missCount) > 0) {
      await query(`UPDATE ${table} SET reconcile_miss_count = $1 WHERE id = $2`, [0, id]);
    }
    return false;
  }
  const next = Number(missCount || 0) + 1;
  if (next >= graceRuns) return true;
  if (!dryRun) {
    await query(`UPDATE ${table} SET reconcile_miss_count = $1 WHERE id = $2`, [next, id]);
  }
  return false;
}

// ── Budget-utilization guard ─────────────────────────────────────────────────
// A percentage budget raise is only meaningful when the budget is what stops the campaign
// from spending more. Without this guard the rule kept raising campaigns that never came
// close to their cap: on 2026-08-18, 25 of the 31 campaigns it raised were using under 10%
// of their daily budget and several were spending €0.00/day, because the qualifying window
// is 60 days long and a campaign that converted well two months ago still passes
// `ACOS <= 15 AND orders >= 3` forever. Each run compounded another +20% on top, so the
// account's total daily budget went 906 → 1090 → 1298 in two runs against flat spend.
//
// "Budget-limited" is measured the way Amazon's own out-of-budget signal is: a day counts
// when the campaign spent at least `minUtilizationPct` of its current daily budget, and the
// campaign must have hit that on at least MIN_BUDGET_LIMITED_DAYS separate days recently.
// A window average would not do — a campaign that maxes out twice a week and idles the rest
// averages low but is genuinely capped on the days it runs.
const BUDGET_UTILIZATION_LOOKBACK_DAYS = 7;
const MIN_BUDGET_LIMITED_DAYS = 2;
const DEFAULT_MIN_BUDGET_UTILIZATION = 70;

// Per-campaign daily spend for the recent window, keyed by Amazon campaign id.
// One query for every campaign the rule matched, not one per campaign.
async function loadRecentDailySpend(amazonCampaignIds, days) {
  const ids = [...new Set(amazonCampaignIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const { rows } = await query(
    `SELECT amazon_id, date, SUM(cost) AS cost
       FROM fact_metrics_daily
      WHERE entity_type = 'campaign'
        AND amazon_id = ANY($1::text[])
        AND date >= CURRENT_DATE - $2::int
        AND date <  CURRENT_DATE
      GROUP BY amazon_id, date`,
    [ids, days]
  );
  const byCampaign = new Map();
  for (const r of rows) {
    if (!byCampaign.has(r.amazon_id)) byCampaign.set(r.amazon_id, []);
    byCampaign.get(r.amazon_id).push(parseFloat(r.cost) || 0);
  }
  return byCampaign;
}

// How many of the recent days the campaign spent at/above `pct` of `budget`.
function budgetLimitedDays(dailySpend, budget, pct) {
  if (!Array.isArray(dailySpend) || !budget || budget <= 0) return 0;
  const floor = budget * (pct / 100);
  return dailySpend.filter(cost => cost >= floor).length;
}

// Fill in the ratio metrics the rule conditions can reference. Mutates and returns `m`
// so it works both standalone and as a .map() callback over query rows.
function withDerivedMetrics(m) {
  if (parseFloat(m.sales) > 0)       m.acos = parseFloat(m.spend) / parseFloat(m.sales) * 100;
  if (parseFloat(m.spend) > 0)       m.roas = parseFloat(m.sales) / parseFloat(m.spend);
  if (parseFloat(m.impressions) > 0) m.ctr  = parseFloat(m.clicks) / parseFloat(m.impressions) * 100;
  if (parseFloat(m.clicks) > 0)      m.cpc  = parseFloat(m.spend) / parseFloat(m.clicks);
  return m;
}

// ── Condition operators ───────────────────────────────────────────────────────
function evaluate(conditions, metrics) {
  return conditions.every(cond => {
    const val       = parseFloat(metrics[cond.metric] ?? 0);
    const threshold = parseFloat(cond.value);
    switch (cond.op) {
      case "gt":  return val >  threshold;
      case "gte": return val >= threshold;
      case "lt":  return val <  threshold;
      case "lte": return val <= threshold;
      case "eq":  return val === threshold;
      case "neq": return val !== threshold;
      default:    return false;
    }
  });
}

// ── Execute rule synchronously ────────────────────────────────────────────────
async function executeRule(rule, workspaceId, dryRun = false, actorId = null, actorName = "Rule Engine") {
  const conditions = typeof rule.conditions === "string" ? JSON.parse(rule.conditions) : rule.conditions;
  const actions    = typeof rule.actions    === "string" ? JSON.parse(rule.actions)    : rule.actions;
  const scope      = typeof rule.scope      === "string" ? JSON.parse(rule.scope)      : (rule.scope  || {});
  const safety     = typeof rule.safety     === "string" ? JSON.parse(rule.safety)     : (rule.safety || {});

  // Defense in depth: an empty conditions array makes `Array.prototype.every`
  // return true for every entity — so a rule with no conditions and a
  // pause/negative action would mass-affect EVERY keyword in scope. Reject
  // here regardless of where the rule came from (preview body, DB row, future
  // import path) so this can never happen by accident.
  if (!Array.isArray(conditions) || conditions.length === 0) {
    throw new Error("Rule must have at least one condition");
  }
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("Rule must have at least one action");
  }

  // ── Period ──────────────────────────────────────────────────────────────────
  const periodDays = parseInt(scope.period_days) || 14;
  let startDate, endDate;
  if (periodDays === 1) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    startDate = yesterday;
    endDate   = yesterday;
  } else {
    endDate   = new Date().toISOString().split("T")[0];
    startDate = new Date(Date.now() - periodDays * 86400000).toISOString().split("T")[0];
  }

  // Look up org_id once (needed for writeAudit)
  const { rows: [ws] } = await query("SELECT org_id FROM workspaces WHERE id = $1", [workspaceId]);
  const orgId = ws?.org_id || null;

  // Load campaign exemptions — campaigns globally excluded from all rules
  const { rows: exemRows } = await query(
    `SELECT campaign_id FROM campaign_exemptions
     WHERE workspace_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
    [workspaceId]
  );
  const exemptedCampaignIds = new Set(exemRows.map(r => String(r.campaign_id)));

  // Wrap writeAudit to always attach rule identity for traceability in the audit journal
  const writeRuleAudit = (opts) => writeAudit({ ...opts, metadata: { rule_id: rule.id, rule_name: rule.name } });

  // Track the result of an Amazon write-back against its audit row so the journal reflects
  // whether the change actually reached Amazon (amazon_status). Handles both raw put() promises
  // (resolve = success, reject = error) and writeback helpers that resolve to { ok, error }.
  // Always non-fatal — a failed write-back never throws out of executeRule (local DB stays updated).
  //
  // Every call is also collected into pendingWritebacks (see below) — these promises are
  // fire-and-forget from the caller's perspective (the main entity loop doesn't await them, so
  // network I/O doesn't block per-entity processing), but a duplicate-add write-back can end up
  // deleting a negative_keywords/negative_targets row (see writeback.js recoverDuplicateNegativeKeyword)
  // *after* it's already been re-read and archived by the reconciliation pass later in this same
  // function, silently discarding that archive's intent. Awaiting pendingWritebacks before
  // reconciliation starts (below) closes that race.
  //
  // A rejected write-back is also recorded in writebackErrors so the run result reports it.
  // Without this the run reports "completed / 0 failures" while Amazon rejected the change —
  // the local DB was updated either way, so nothing else in executeRule notices. Only the
  // audit row carried the failure, which meant recurring rejections stayed invisible for weeks.
  const pendingWritebacks = [];
  const writebackErrors   = [];
  // Amazon's v3 batch endpoints answer 207 Multi-Status: a per-item rejection rides in
  // `<dataKey>.error[]` while the HTTP status stays 2xx, so a raw put() resolves normally and
  // `r.ok` is undefined. Checking only `r.ok === false` therefore reads every partial rejection
  // from a raw put() as a success. Inspect both shapes: the {ok,error} contract returned by the
  // writeback helpers, and a raw response body carrying a 207 error list.
  const RESPONSE_KEYS = ["campaigns", "keywords", "negativeKeywords", "negativeTargetingClauses", "targets", "adGroups"];
  const writebackFailure = (r) => {
    if (!r || typeof r !== "object") return null;
    if (r.ok === false) return r.error || "Amazon rejected the write-back";
    for (const key of RESPONSE_KEYS) {
      const err = partialError(r, key);
      if (err) return err;
    }
    return null;
  };

  // `onFailure(error)` lets a caller undo the local row it wrote optimistically. Creating a
  // negative is the one write-back whose failure the system cannot otherwise notice: the row
  // carries a synthetic id, so no sync will ever reconcile it against Amazon, and the add path
  // then skips the term forever as `already_negative`. See rollbackFailedNegative below.
  const trackWriteback = (auditId, promise, warnMsg, ctx = {}, onFailure = null) => {
    const record = (error) => {
      writebackErrors.push({ ...ctx, stage: "amazon_writeback", error: String(error) });
    };
    const fail = async (error) => {
      record(error);
      if (onFailure) {
        // A rollback that throws must not swallow the audit update below.
        try { await onFailure(error); }
        catch (e) { logger.warn("Write-back rollback failed", { error: e.message }); }
      }
      return updateAuditStatus(auditId, "error", error);
    };
    const tracked = promise
      .then(r => {
        const failure = writebackFailure(r);
        return failure ? fail(failure) : updateAuditStatus(auditId, "success", null);
      })
      .catch(e => {
        logger.warn(warnMsg, { error: e.message });
        return fail(e.message);
      });
    pendingWritebacks.push(tracked);
    return tracked;
  };

  // Undo a negative this run created locally but Amazon refused. The row goes back to
  // 'archived' — the honest state, since nothing is blocking the term — and keeps the reason,
  // so the next run can tell a permanently-invalid keyword (skip, with the reason reported)
  // from a transient outage (retry). The id is only replaced when it is still a placeholder;
  // a real Amazon id means the entity does exist and must stay addressable.
  const rollbackFailedNegative = (table, idColumn, localId) => async (error) => {
    if (!RECONCILE_TABLES.has(table)) throw new Error(`Unexpected rollback table: ${table}`);
    if (!localId) return;
    await query(
      `UPDATE ${table}
          SET state = 'archived',
              ${idColumn} = CASE WHEN ${idColumn} ~ '^[0-9]+$' THEN ${idColumn}
                                 ELSE 'archived-' || (EXTRACT(EPOCH FROM NOW())::bigint) || '-' || id END,
              writeback_error = $2, writeback_failed_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [localId, String(error).slice(0, 2000)]
    );
  };

  // Separate bid/budget threshold conditions (applied in SQL WHERE) from metric conditions (post-fetch filter).
  // daily_budget is only a valid SQL threshold on campaign scope; for other scopes it stays in metricConditions
  // (evaluates against entity.daily_budget which is undefined → treated as 0, effectively ignored).
  const entityType       = scope.entity_type || "keyword";
  const bidConditions    = conditions.filter(c => c.metric === "bid" || (c.metric === "daily_budget" && entityType === "campaign"));
  const metricConditions = conditions.filter(c => c.metric !== "bid" && !(c.metric === "daily_budget" && entityType === "campaign"));
  const BID_OPS    = { gt: ">", gte: ">=", lt: "<", lte: "<=", eq: "=", neq: "!=" };

  // ── Helper: build campaign_name_contains clause ──────────────────────────────
  function addCampaignNameFilter(conds, params, piRef, alias = "c") {
    if (!scope.campaign_name_contains) return piRef;
    const names = scope.campaign_name_contains.split(",").map(s => s.trim()).filter(Boolean);
    if (!names.length) return piRef;
    const exclude = scope.campaign_name_mode === "exclude";
    const op = exclude ? "NOT ILIKE" : "ILIKE";
    const join = exclude ? " AND " : " OR ";
    if (names.length === 1) {
      conds.push(`${alias}.name ${op} $${piRef++}`);
      params.push(`%${names[0]}%`);
    } else {
      const parts = names.map(() => `${alias}.name ${op} $${piRef++}`).join(join);
      conds.push(`(${parts})`);
      params.push(...names.map(n => `%${n}%`));
    }
    return piRef;
  }

  // ── Fetch keywords ────────────────────────────────────────────────────────
  let keywords = [];
  if (entityType === "keyword") {
    const kConds  = ["k.workspace_id = $1"];
    const kParams = [workspaceId];
    let pi = 2;

    if (scope.campaign_ids?.length) {
      kConds.push(`k.campaign_id = ANY($${pi++}::uuid[])`);
      kParams.push(scope.campaign_ids);
    }
    if (scope.ad_group_ids?.length) {
      kConds.push(`k.ad_group_id = ANY($${pi++}::uuid[])`);
      kParams.push(scope.ad_group_ids);
    }
    if (scope.campaign_type) {
      kConds.push(`c.campaign_type = $${pi++}`);
      kParams.push(scope.campaign_type);
    }
    if (scope.match_types?.length) {
      kConds.push(`k.match_type = ANY($${pi++}::text[])`);
      kParams.push(scope.match_types);
    }
    if (scope.campaign_targeting_type) {
      kConds.push(`LOWER(c.targeting_type) = $${pi++}`);
      kParams.push(scope.campaign_targeting_type.toLowerCase());
    }
    pi = addCampaignNameFilter(kConds, kParams, pi);
    for (const bc of bidConditions) {
      kConds.push(`k.bid ${BID_OPS[bc.op] || ">="} $${pi++}`);
      kParams.push(parseFloat(bc.value));
    }
    kConds.push("k.state != 'archived'");

    const { rows } = await query(
      `SELECT
         k.id, k.keyword_text, k.match_type, k.state, k.bid,
         k.amazon_keyword_id,
         k.campaign_id, k.ad_group_id,
         c.name  AS campaign_name, c.campaign_type, c.amazon_campaign_id, c.state AS campaign_state,
         ag.name AS ad_group_name, ag.amazon_ag_id AS amazon_ad_group_id,
         p.id    AS profile_db_id,
         p.profile_id  AS amazon_profile_id,
         p.connection_id,
         p.marketplace_id,
         COALESCE(SUM(m.clicks), 0)      AS clicks,
         COALESCE(SUM(m.cost),   0)      AS spend,
         COALESCE(SUM(m.sales_14d), 0)   AS sales,
         COALESCE(SUM(m.orders_14d), 0)  AS orders,
         COALESCE(SUM(m.impressions), 0) AS impressions,
         CASE WHEN COALESCE(SUM(m.sales_14d),0) > 0
              THEN SUM(m.cost)/SUM(m.sales_14d)*100 END  AS acos,
         CASE WHEN COALESCE(SUM(m.cost),0) > 0
              THEN SUM(m.sales_14d)/SUM(m.cost) END       AS roas,
         CASE WHEN COALESCE(SUM(m.impressions),0) > 0
              THEN SUM(m.clicks)::numeric/SUM(m.impressions)*100 END AS ctr,
         CASE WHEN COALESCE(SUM(m.clicks),0) > 0
              THEN SUM(m.cost)/SUM(m.clicks) END          AS cpc
       FROM keywords k
       JOIN campaigns  c  ON c.id  = k.campaign_id
       JOIN ad_groups  ag ON ag.id = k.ad_group_id
       JOIN amazon_profiles p ON p.id = c.profile_id
       LEFT JOIN fact_metrics_daily m
         ON m.amazon_id = k.amazon_keyword_id
         AND m.entity_type = 'keyword'
         AND m.date BETWEEN $${pi++} AND $${pi++}
       WHERE ${kConds.join(" AND ")}
       GROUP BY k.id, k.keyword_text, k.match_type, k.state, k.bid,
                k.amazon_keyword_id, k.campaign_id, k.ad_group_id,
                c.name, c.campaign_type, c.amazon_campaign_id, c.state,
                ag.name, ag.amazon_ag_id,
                p.id, p.profile_id, p.connection_id, p.marketplace_id`,
      [...kParams, startDate, endDate]
    );
    keywords = rows.map(r => ({ ...r, entity_type: "keyword" }));
  }

  // ── Fetch targets ─────────────────────────────────────────────────────────
  let targets = [];
  if (entityType === "product_target") {
    const tConds  = ["t.workspace_id = $1"];
    const tParams = [workspaceId];
    let tPi = 2;

    if (scope.campaign_ids?.length) {
      tConds.push(`t.campaign_id = ANY($${tPi++}::uuid[])`);
      tParams.push(scope.campaign_ids);
    }
    if (scope.ad_group_ids?.length) {
      tConds.push(`t.ad_group_id = ANY($${tPi++}::uuid[])`);
      tParams.push(scope.ad_group_ids);
    }
    if (scope.campaign_type) {
      tConds.push(`c.campaign_type = $${tPi++}`);
      tParams.push(scope.campaign_type);
    }
    tPi = addCampaignNameFilter(tConds, tParams, tPi);
    if (scope.campaign_targeting_type) {
      tConds.push(`LOWER(c.targeting_type) = $${tPi++}`);
      tParams.push(scope.campaign_targeting_type.toLowerCase());
    }
    if (scope.targeting_type) {
      const ttSqlMap = {
        "category":      `(t.expression->0->>'type' IN ('ASIN_CATEGORY_SAME_AS', 'asinCategorySameAs'))`,
        "asin":          `(t.expression->0->>'type' IN ('ASIN_SAME_AS', 'asinSameAs'))`,
        "auto_targeting":`(LOWER(t.expression_type) = 'auto')`,
        "audience":      `(t.expression->0->>'type' IN ('views', 'purchases', 'similarProduct'))`,
        // backward-compat aliases for rules saved before this change:
        "auto":          `(LOWER(t.expression_type) = 'auto')`,
        "product":       `(t.expression->0->>'type' IN ('ASIN_SAME_AS', 'asinSameAs'))`,
        "views":         `(t.expression->0->>'type' IN ('views', 'purchases', 'similarProduct'))`,
      };
      const ttCond = ttSqlMap[scope.targeting_type];
      if (ttCond) tConds.push(ttCond);
    }
    for (const bc of bidConditions) {
      tConds.push(`t.bid ${BID_OPS[bc.op] || ">="} $${tPi++}`);
      tParams.push(parseFloat(bc.value));
    }
    tConds.push("t.state != 'archived'");

    const { rows } = await query(
      `SELECT
         t.id, t.amazon_target_id, t.expression, t.expression_type,
         t.state, t.bid, t.campaign_id, t.ad_group_id, t.profile_id,
         c.name  AS campaign_name, c.campaign_type, c.amazon_campaign_id, c.state AS campaign_state,
         ag.name AS ad_group_name, ag.amazon_ag_id AS amazon_ad_group_id,
         p.profile_id  AS amazon_profile_id,
         p.connection_id,
         p.marketplace_id,
         COALESCE(SUM(m.clicks), 0)      AS clicks,
         COALESCE(SUM(m.cost),   0)      AS spend,
         COALESCE(SUM(m.sales_14d), 0)   AS sales,
         COALESCE(SUM(m.orders_14d), 0)  AS orders,
         COALESCE(SUM(m.impressions), 0) AS impressions,
         CASE WHEN COALESCE(SUM(m.sales_14d),0) > 0
              THEN SUM(m.cost)/SUM(m.sales_14d)*100 END  AS acos,
         CASE WHEN COALESCE(SUM(m.cost),0) > 0
              THEN SUM(m.sales_14d)/SUM(m.cost) END       AS roas,
         CASE WHEN COALESCE(SUM(m.impressions),0) > 0
              THEN SUM(m.clicks)::numeric/SUM(m.impressions)*100 END AS ctr,
         CASE WHEN COALESCE(SUM(m.clicks),0) > 0
              THEN SUM(m.cost)/SUM(m.clicks) END          AS cpc
       FROM targets t
       JOIN campaigns  c  ON c.id  = t.campaign_id
       JOIN amazon_profiles p ON p.id = t.profile_id
       LEFT JOIN ad_groups ag ON ag.id = t.ad_group_id
       LEFT JOIN fact_metrics_daily m
         ON m.amazon_id = t.amazon_target_id
         AND m.entity_type = 'target'
         AND m.date BETWEEN $${tPi++} AND $${tPi++}
       WHERE ${tConds.join(" AND ")}
       GROUP BY t.id, t.amazon_target_id, t.expression, t.expression_type,
                t.state, t.bid, t.campaign_id, t.ad_group_id, t.profile_id,
                c.name, c.campaign_type, c.amazon_campaign_id, c.state,
                ag.name, ag.amazon_ag_id,
                p.profile_id, p.connection_id, p.marketplace_id`,
      [...tParams, startDate, endDate]
    );
    targets = rows.map(r => ({ ...r, entity_type: "target" }));
  }

  // ── Fetch search terms ────────────────────────────────────────────────────
  // Aggregates search_term_metrics over the period. Each entity represents one
  // (query, campaign, ad_group) combination. Synthetic state="enabled" so the
  // existing add_negative_keyword/add_negative_target handlers accept them.
  // The query text becomes the `keyword_text` so the negative-keyword writer
  // doesn't need a special branch.
  let searchTerms = [];
  if (entityType === "search_term") {
    const sConds  = ["stm.workspace_id = $1", "stm.date_start >= $2", "stm.date_end <= $3", "stm.campaign_id IS NOT NULL", "stm.ad_group_id IS NOT NULL"];
    const sParams = [workspaceId, startDate, endDate];
    let sPi = 4;

    if (scope.campaign_ids?.length) {
      sConds.push(`stm.campaign_id = ANY($${sPi++}::uuid[])`);
      sParams.push(scope.campaign_ids);
    }
    if (scope.ad_group_ids?.length) {
      sConds.push(`stm.ad_group_id = ANY($${sPi++}::uuid[])`);
      sParams.push(scope.ad_group_ids);
    }
    if (scope.campaign_type) {
      sConds.push(`c.campaign_type = $${sPi++}`);
      sParams.push(scope.campaign_type);
    }
    if (scope.match_types?.length) {
      sConds.push(`LOWER(stm.match_type) = ANY($${sPi++}::text[])`);
      sParams.push(scope.match_types.map(m => m.toLowerCase()));
    }
    if (scope.campaign_targeting_type) {
      sConds.push(`LOWER(c.targeting_type) = $${sPi++}`);
      sParams.push(scope.campaign_targeting_type.toLowerCase());
    }
    if (scope.search_term_subtype === "asin") {
      sConds.push(`stm.query ~* '^B0[A-Z0-9]{8,9}$'`);
    } else if (scope.search_term_subtype === "keyword") {
      sConds.push(`stm.query !~* '^B0[A-Z0-9]{8,9}$'`);
    }
    sPi = addCampaignNameFilter(sConds, sParams, sPi);

    const { rows } = await query(
      `SELECT
         MIN(stm.id::text) AS id,
         -- Group on the NORMALIZED query. Amazon's reports return the same shopper term in
         -- several typographic spellings ("150 kg" with U+00A0 vs a plain space); they are one
         -- and the same negative keyword on Amazon, so they must be one entity here too.
         -- Reconciliation matches negatives on normalized text, and if this path grouped on the
         -- raw text the two would disagree — the add path scoring one spelling in isolation,
         -- reconciliation scoring the merged total — which is exactly the add/remove oscillation
         -- this grouping exists to prevent.
         ${sqlNormalizeKeywordText("stm.query")} AS keyword_text,
         stm.campaign_id, stm.ad_group_id,
         stm.match_type AS source_match_type,
         c.name  AS campaign_name, c.campaign_type, c.amazon_campaign_id, c.state AS campaign_state,
         ag.name AS ad_group_name, ag.amazon_ag_id AS amazon_ad_group_id,
         p.id    AS profile_db_id,
         p.profile_id  AS amazon_profile_id,
         p.connection_id,
         p.marketplace_id,
         'enabled'::text AS state,
         SUM(stm.clicks)      AS clicks,
         SUM(stm.spend)       AS spend,
         SUM(stm.orders)      AS orders,
         SUM(stm.sales)       AS sales,
         SUM(stm.impressions) AS impressions,
         CASE WHEN SUM(stm.sales) > 0
              THEN SUM(stm.spend)/SUM(stm.sales)*100 END AS acos,
         CASE WHEN SUM(stm.spend) > 0
              THEN SUM(stm.sales)/SUM(stm.spend) END     AS roas,
         CASE WHEN SUM(stm.impressions) > 0
              THEN SUM(stm.clicks)::numeric/SUM(stm.impressions)*100 END AS ctr,
         CASE WHEN SUM(stm.clicks) > 0
              THEN SUM(stm.spend)/SUM(stm.clicks) END    AS cpc
       FROM search_term_metrics stm
       JOIN campaigns c        ON c.id  = stm.campaign_id
       JOIN ad_groups ag       ON ag.id = stm.ad_group_id
       JOIN amazon_profiles p  ON p.id  = stm.profile_id
       WHERE ${sConds.join(" AND ")}
       GROUP BY ${sqlNormalizeKeywordText("stm.query")}, stm.campaign_id, stm.ad_group_id, stm.match_type,
                c.name, c.campaign_type, c.amazon_campaign_id, c.state,
                ag.name, ag.amazon_ag_id,
                p.id, p.profile_id, p.connection_id, p.marketplace_id`,
      sParams
    );
    searchTerms = rows.map(r => ({ ...r, entity_type: "search_term" }));
  }

  // ── Fetch ad groups ───────────────────────────────────────────────────────
  let adGroupEntities = [];
  if (entityType === "ad_group") {
    const agConds  = ["ag.workspace_id = $1"];
    const agParams = [workspaceId];
    let agPi = 2;

    if (scope.campaign_ids?.length) {
      agConds.push(`ag.campaign_id = ANY($${agPi++}::uuid[])`);
      agParams.push(scope.campaign_ids);
    }
    if (scope.ad_group_ids?.length) {
      agConds.push(`ag.id = ANY($${agPi++}::uuid[])`);
      agParams.push(scope.ad_group_ids);
    }
    if (scope.campaign_type) {
      agConds.push(`c.campaign_type = $${agPi++}`);
      agParams.push(scope.campaign_type);
    }
    if (scope.campaign_targeting_type) {
      agConds.push(`LOWER(c.targeting_type) = $${agPi++}`);
      agParams.push(scope.campaign_targeting_type.toLowerCase());
    }
    agPi = addCampaignNameFilter(agConds, agParams, agPi);
    for (const bc of bidConditions) {
      agConds.push(`ag.default_bid ${BID_OPS[bc.op] || ">="} $${agPi++}`);
      agParams.push(parseFloat(bc.value));
    }
    agConds.push("ag.state != 'archived'");

    const { rows } = await query(
      `SELECT
         ag.id, ag.amazon_ag_id, ag.name AS ad_group_name, ag.state, ag.default_bid,
         ag.campaign_id,
         c.name  AS campaign_name, c.campaign_type, c.amazon_campaign_id, c.state AS campaign_state,
         p.id    AS profile_db_id,
         p.profile_id  AS amazon_profile_id,
         p.connection_id,
         p.marketplace_id,
         COALESCE(SUM(m.clicks), 0)      AS clicks,
         COALESCE(SUM(m.cost),   0)      AS spend,
         COALESCE(SUM(m.sales_14d), 0)   AS sales,
         COALESCE(SUM(m.orders_14d), 0)  AS orders,
         COALESCE(SUM(m.impressions), 0) AS impressions,
         CASE WHEN COALESCE(SUM(m.sales_14d),0) > 0
              THEN SUM(m.cost)/SUM(m.sales_14d)*100 END  AS acos,
         CASE WHEN COALESCE(SUM(m.cost),0) > 0
              THEN SUM(m.sales_14d)/SUM(m.cost) END       AS roas,
         CASE WHEN COALESCE(SUM(m.impressions),0) > 0
              THEN SUM(m.clicks)::numeric/SUM(m.impressions)*100 END AS ctr,
         CASE WHEN COALESCE(SUM(m.clicks),0) > 0
              THEN SUM(m.cost)/SUM(m.clicks) END          AS cpc
       FROM ad_groups ag
       JOIN campaigns  c  ON c.id  = ag.campaign_id
       JOIN amazon_profiles p ON p.id = ag.profile_id
       LEFT JOIN fact_metrics_daily m
         ON m.amazon_id = ag.amazon_ag_id
         AND m.entity_type = 'ad_group'
         AND m.date BETWEEN $${agPi++} AND $${agPi++}
       WHERE ${agConds.join(" AND ")}
       GROUP BY ag.id, ag.amazon_ag_id, ag.name, ag.state, ag.default_bid,
                ag.campaign_id, c.name, c.campaign_type, c.amazon_campaign_id, c.state,
                p.id, p.profile_id, p.connection_id, p.marketplace_id`,
      [...agParams, startDate, endDate]
    );
    adGroupEntities = rows.map(r => ({ ...r, entity_type: "ad_group", keyword_text: r.ad_group_name }));
  }

  // ── Fetch campaigns ───────────────────────────────────────────────────────
  let campaignEntities = [];
  if (entityType === "campaign") {
    const cConds  = ["c.workspace_id = $1"];
    const cCampParams = [workspaceId];
    let cPi = 2;

    if (scope.campaign_ids?.length) {
      cConds.push(`c.id = ANY($${cPi++}::uuid[])`);
      cCampParams.push(scope.campaign_ids);
    }
    if (scope.campaign_type) {
      cConds.push(`c.campaign_type = $${cPi++}`);
      cCampParams.push(scope.campaign_type);
    }
    if (scope.campaign_targeting_type) {
      cConds.push(`LOWER(c.targeting_type) = $${cPi++}`);
      cCampParams.push(scope.campaign_targeting_type.toLowerCase());
    }
    cPi = addCampaignNameFilter(cConds, cCampParams, cPi);
    // "bid" conditions on campaign scope are interpreted as daily_budget thresholds
    for (const bc of bidConditions) {
      cConds.push(`c.daily_budget ${BID_OPS[bc.op] || ">="} $${cPi++}`);
      cCampParams.push(parseFloat(bc.value));
    }
    cConds.push("c.state != 'archived'");

    const { rows } = await query(
      `SELECT
         c.id, c.amazon_campaign_id, c.name AS campaign_name, c.state, c.daily_budget,
         c.campaign_type, c.targeting_type,
         c.state AS campaign_state,
         p.id    AS profile_db_id,
         p.profile_id  AS amazon_profile_id,
         p.connection_id,
         p.marketplace_id,
         COALESCE(SUM(m.clicks), 0)      AS clicks,
         COALESCE(SUM(m.cost),   0)      AS spend,
         COALESCE(SUM(m.sales_14d), 0)   AS sales,
         COALESCE(SUM(m.orders_14d), 0)  AS orders,
         COALESCE(SUM(m.impressions), 0) AS impressions,
         CASE WHEN COALESCE(SUM(m.sales_14d),0) > 0
              THEN SUM(m.cost)/SUM(m.sales_14d)*100 END  AS acos,
         CASE WHEN COALESCE(SUM(m.cost),0) > 0
              THEN SUM(m.sales_14d)/SUM(m.cost) END       AS roas,
         CASE WHEN COALESCE(SUM(m.impressions),0) > 0
              THEN SUM(m.clicks)::numeric/SUM(m.impressions)*100 END AS ctr,
         CASE WHEN COALESCE(SUM(m.clicks),0) > 0
              THEN SUM(m.cost)/SUM(m.clicks) END          AS cpc
       FROM campaigns c
       JOIN amazon_profiles p ON p.id = c.profile_id
       LEFT JOIN fact_metrics_daily m
         ON m.amazon_id = c.amazon_campaign_id
         AND m.entity_type = 'campaign'
         AND m.date BETWEEN $${cPi++} AND $${cPi++}
       WHERE ${cConds.join(" AND ")}
       GROUP BY c.id, c.amazon_campaign_id, c.name, c.state, c.daily_budget,
                c.campaign_type, c.targeting_type,
                p.id, p.profile_id, p.connection_id, p.marketplace_id`,
      [...cCampParams, startDate, endDate]
    );
    campaignEntities = rows.map(r => ({ ...r, entity_type: "campaign", keyword_text: r.campaign_name }));
  }

  const entities = [...keywords, ...targets, ...searchTerms, ...adGroupEntities, ...campaignEntities];
  const matched  = entities.filter(e => evaluate(metricConditions, e));
  const applied  = [];
  const skipped  = [];
  const errors   = [];

  // Recent per-day spend, loaded once, only when a percentage raise can actually fire.
  const raisesBudget = actions.some(a => a.type === "adjust_budget_pct");
  const recentDailySpend = raisesBudget
    ? await loadRecentDailySpend(
        matched.filter(e => e.entity_type === "campaign").map(e => e.amazon_campaign_id),
        BUDGET_UTILIZATION_LOOKBACK_DAYS
      )
    : new Map();

  // Helper: record an entity that matched conditions but cannot have the
  // action applied (e.g., already in target state, duplicate negative).
  // Reason key is i18n-resolved on the frontend so UX explanations stay close
  // to translation files. Keep keys stable — they're shown in tooltips.
  // `extra` carries reason-specific detail the tooltip cannot derive from the metrics alone
  // (e.g. how far a campaign actually was from its budget). Optional — omitted for most skips.
  const recordSkip = (entity, action, reason, extra) => {
    skipped.push({
      entity_id: entity.id,
      entity_type: entity.entity_type,
      keyword_text: entity.keyword_text || null,
      expression: entity.expression || null,
      campaign_name: entity.campaign_name || null,
      action: action.type,
      reason,
      metrics: {
        clicks: entity.clicks, orders: entity.orders,
        spend: entity.spend, acos: entity.acos,
      },
      ...(extra ? { detail: extra } : {}),
    });
  };

  // The row describing this negative for this ad group, if one already exists. Negatives are
  // written at ad-group level, so a row for a different ad group is a different negative.
  const priorNegTargetRow = (existing, adGroupId) =>
    (existing || []).find(r => String(r.ad_group_id ?? "") === String(adGroupId ?? "")) || null;

  // Claim the negative_target row for an expression the rule wants negated.
  //
  // `existing` is every row matching the call site's dedup predicate, in ANY state. If one is
  // already enabled the caller skips as `already_negative` (unchanged, campaign-wide behaviour).
  // Otherwise an inactive row for the same ad group is re-activated and re-owned rather than
  // inserting a second row — same reasoning as the negative-keyword path: leaving the row owned
  // by the rule that archived it is what let one rule undo another's work on every run.
  // Returns the local row id to hand to the Amazon write-back, or null if nothing was written.
  const claimNegTargetRow = async (existing, { adGroupId, sourceEntityType, insert }) => {
    const prior = existing.find(r =>
      String(r.ad_group_id ?? "") === String(adGroupId ?? "")) || null;
    if (prior) {
      // A freed placeholder ("archived-…"/"rule-…") must not be mistaken for an Amazon id;
      // key the fresh placeholder on the row's own uuid so it stays unique.
      const synthetic = isSyntheticNegId(prior.amazon_neg_target_id);
      await query(
        // reconcile_miss_count resets — a re-owned row is a fresh negative for its new owner.
        `UPDATE negative_targets
            SET state='enabled', source_rule_id=$1, source_entity_type=$2,
                reconcile_miss_count=0, writeback_error=NULL, writeback_failed_at=NULL,
                updated_at=NOW()${synthetic ? ", amazon_neg_target_id=$4" : ""}
          WHERE id=$3`,
        synthetic
          ? [rule.id, sourceEntityType, prior.id, `rule-neg-${prior.id}`]
          : [rule.id, sourceEntityType, prior.id]
      );
      return prior.id;
    }
    const { rows } = await query(insert.sql, insert.params);
    return rows[0]?.id || null;
  };

  // Split matched into exempted (skipped entirely) and processable
  let exemptedCount = 0;
  if (exemptedCampaignIds.size > 0) {
    for (const entity of matched) {
      const cid = entity.entity_type === "campaign" ? entity.id : entity.campaign_id;
      if (exemptedCampaignIds.has(String(cid))) exemptedCount++;
    }
  }

  for (const entity of matched) {
    // Skip entities belonging to globally exempted campaigns
    if (exemptedCampaignIds.size > 0) {
      const cid = entity.entity_type === "campaign" ? entity.id : entity.campaign_id;
      if (exemptedCampaignIds.has(String(cid))) continue;
    }

    for (const action of actions) {
      try {
        if (entity.entity_type !== "campaign" && entity.campaign_state && entity.campaign_state !== "enabled") {
          recordSkip(entity, action, "campaign_not_enabled"); continue;
        }

        // ── pause_keyword ───────────────────────────────────────────────────
        if (action.type === "pause_keyword") {
          if (entity.entity_type !== "keyword") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "paused") { recordSkip(entity, action, "already_paused"); continue; }
          if (!dryRun) {
            await query("UPDATE keywords SET state = 'paused', updated_at = NOW() WHERE id = $1", [entity.id]);
            const pauseKwAudit = await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "keyword.pause_keyword", entityType: "keyword",
              entityId: entity.id, entityName: entity.keyword_text,
              beforeData: { state: entity.state }, afterData: { state: "paused" }, source: "rule",
            });
            if (entity.amazon_keyword_id && entity.connection_id) {
              trackWriteback(pauseKwAudit, pushKeywordUpdates([{
                amazonKeywordId: entity.amazon_keyword_id,
                campaignType: entity.campaign_type,
                connectionId: entity.connection_id,
                profileId: String(entity.amazon_profile_id),
                marketplaceId: entity.marketplace_id,
                state: "paused",
              }]), "Rule keyword pause write-back failed",
                { entity_id: entity.id, entity_type: entity.entity_type, keyword_text: entity.keyword_text, action: "pause_keyword" });
            }
          }
          applied.push({
            entity_type: entity.entity_type, entity_id: entity.id, keyword_text: entity.keyword_text,
            campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name, action: "pause_keyword",
            previous_state: entity.state, new_state: "paused",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos },
          });

        // ── enable_keyword ──────────────────────────────────────────────────
        } else if (action.type === "enable_keyword") {
          if (entity.entity_type !== "keyword") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "enabled") { recordSkip(entity, action, "already_enabled"); continue; }
          if (!dryRun) {
            await query("UPDATE keywords SET state = 'enabled', updated_at = NOW() WHERE id = $1", [entity.id]);
            const enableKwAudit = await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "keyword.enable_keyword", entityType: "keyword",
              entityId: entity.id, entityName: entity.keyword_text,
              beforeData: { state: entity.state }, afterData: { state: "enabled" }, source: "rule",
            });
            if (entity.amazon_keyword_id && entity.connection_id) {
              trackWriteback(enableKwAudit, pushKeywordUpdates([{
                amazonKeywordId: entity.amazon_keyword_id,
                campaignType: entity.campaign_type,
                connectionId: entity.connection_id,
                profileId: String(entity.amazon_profile_id),
                marketplaceId: entity.marketplace_id,
                state: "enabled",
              }]), "Rule keyword enable write-back failed",
                { entity_id: entity.id, entity_type: entity.entity_type, keyword_text: entity.keyword_text, action: "enable_keyword" });
            }
          }
          applied.push({
            entity_type: entity.entity_type, entity_id: entity.id, keyword_text: entity.keyword_text,
            campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name, action: "enable_keyword",
            previous_state: entity.state, new_state: "enabled",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders },
          });

        // ── adjust_bid_pct (keyword) ────────────────────────────────────────
        } else if (action.type === "adjust_bid_pct") {
          if (entity.entity_type !== "keyword") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }
          const pct        = parseFloat(action.value || 0) / 100;
          const currentBid = parseFloat(entity.bid || 0.10);
          const minBid     = parseFloat(safety.min_bid || 0.02);
          const maxBid     = parseFloat(safety.max_bid || 50);
          const newBid     = Math.round(Math.max(minBid, Math.min(maxBid, currentBid * (1 + pct))) * 100) / 100;
          if (!dryRun) {
            await query("UPDATE keywords SET bid = $1, updated_at = NOW() WHERE id = $2", [newBid, entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "keyword.adjust_bid_pct", entityType: "keyword",
              entityId: entity.id, entityName: entity.keyword_text,
              beforeData: { bid: currentBid }, afterData: { bid: newBid }, source: "rule",
            });
            if (entity.amazon_keyword_id && entity.connection_id) {
              pushKeywordUpdates([{
                amazonKeywordId: entity.amazon_keyword_id,
                campaignType: entity.campaign_type,
                connectionId: entity.connection_id,
                profileId: String(entity.amazon_profile_id),
                marketplaceId: entity.marketplace_id,
                bid: newBid,
              }]).catch(e => logger.warn("Rule keyword bid write-back failed", { error: e.message }));
            }
          }
          applied.push({
            entity_type: entity.entity_type, entity_id: entity.id, keyword_text: entity.keyword_text,
            campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name, action: "adjust_bid_pct",
            previous_bid: currentBid, new_bid: newBid,
            change_pct: (pct * 100).toFixed(1) + "%",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos },
          });

        // ── set_bid (keyword) ───────────────────────────────────────────────
        } else if (action.type === "set_bid") {
          if (entity.entity_type !== "keyword") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }
          const newBid     = parseFloat(action.value || 0.10);
          const currentBid = parseFloat(entity.bid || 0);
          const minBid     = parseFloat(safety.min_bid || 0.02);
          const maxBid     = parseFloat(safety.max_bid || 50);
          const clampedBid = Math.round(Math.max(minBid, Math.min(maxBid, newBid)) * 100) / 100;
          if (!dryRun) {
            await query("UPDATE keywords SET bid = $1, updated_at = NOW() WHERE id = $2", [clampedBid, entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "keyword.set_bid", entityType: "keyword",
              entityId: entity.id, entityName: entity.keyword_text,
              beforeData: { bid: currentBid }, afterData: { bid: clampedBid }, source: "rule",
            });
            if (entity.amazon_keyword_id && entity.connection_id) {
              pushKeywordUpdates([{
                amazonKeywordId: entity.amazon_keyword_id,
                campaignType: entity.campaign_type,
                connectionId: entity.connection_id,
                profileId: String(entity.amazon_profile_id),
                marketplaceId: entity.marketplace_id,
                bid: clampedBid,
              }]).catch(e => logger.warn("Rule keyword set_bid write-back failed", { error: e.message }));
            }
          }
          applied.push({
            entity_type: entity.entity_type, entity_id: entity.id, keyword_text: entity.keyword_text,
            campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name, action: "set_bid",
            previous_bid: currentBid, new_bid: clampedBid,
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos },
          });

        // ── pause_target ────────────────────────────────────────────────────
        } else if (action.type === "pause_target") {
          if (entity.entity_type !== "target") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "paused") { recordSkip(entity, action, "already_paused"); continue; }
          if (!dryRun) {
            await query("UPDATE targets SET state = 'paused', updated_at = NOW() WHERE id = $1", [entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "target.pause", entityType: "target",
              entityId: entity.id, entityName: JSON.stringify(entity.expression),
              beforeData: { state: entity.state }, afterData: { state: "paused" }, source: "rule",
            });
            if (entity.amazon_target_id && entity.connection_id) {
              const tPath = entity.campaign_type === "sponsoredDisplay" ? "/sd/targets" : "/sp/targets";
              put({
                connectionId: entity.connection_id,
                profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id,
                path: tPath,
                data: { targets: [{ targetId: entity.amazon_target_id, state: "PAUSED" }] },
                group: "keywords",
              }).catch(e => logger.warn("Rule target pause write-back failed", { error: e.message }));
            }
          }
          applied.push({
            entity_type: entity.entity_type, entity_id: entity.id, expression: entity.expression,
            campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name, action: "pause_target",
            previous_state: entity.state, new_state: "paused",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos },
          });

        // ── enable_target ───────────────────────────────────────────────────
        } else if (action.type === "enable_target") {
          if (entity.entity_type !== "target") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "enabled") { recordSkip(entity, action, "already_enabled"); continue; }
          if (!dryRun) {
            await query("UPDATE targets SET state = 'enabled', updated_at = NOW() WHERE id = $1", [entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "target.enable", entityType: "target",
              entityId: entity.id, entityName: JSON.stringify(entity.expression),
              beforeData: { state: entity.state }, afterData: { state: "enabled" }, source: "rule",
            });
            if (entity.amazon_target_id && entity.connection_id) {
              const tPath = entity.campaign_type === "sponsoredDisplay" ? "/sd/targets" : "/sp/targets";
              put({
                connectionId: entity.connection_id,
                profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id,
                path: tPath,
                data: { targets: [{ targetId: entity.amazon_target_id, state: "ENABLED" }] },
                group: "keywords",
              }).catch(e => logger.warn("Rule target enable write-back failed", { error: e.message }));
            }
          }
          applied.push({
            entity_type: entity.entity_type, entity_id: entity.id, expression: entity.expression,
            campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name, action: "enable_target",
            previous_state: entity.state, new_state: "enabled",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders },
          });

        // ── adjust_target_bid_pct ───────────────────────────────────────────
        } else if (action.type === "adjust_target_bid_pct") {
          if (entity.entity_type !== "target") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }
          const pct        = parseFloat(action.value || 0) / 100;
          const currentBid = parseFloat(entity.bid || 0.10);
          const minBid     = parseFloat(safety.min_bid || 0.02);
          const maxBid     = parseFloat(safety.max_bid || 50);
          const newBid     = Math.round(Math.max(minBid, Math.min(maxBid, currentBid * (1 + pct))) * 100) / 100;
          if (!dryRun) {
            await query("UPDATE targets SET bid = $1, updated_at = NOW() WHERE id = $2", [newBid, entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "target.adjust_bid_pct", entityType: "target",
              entityId: entity.id, entityName: JSON.stringify(entity.expression),
              beforeData: { bid: currentBid }, afterData: { bid: newBid }, source: "rule",
            });
            if (entity.amazon_target_id && entity.connection_id) {
              const tPath = entity.campaign_type === "sponsoredDisplay" ? "/sd/targets" : "/sp/targets";
              put({
                connectionId: entity.connection_id,
                profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id,
                path: tPath,
                data: { targets: [{ targetId: entity.amazon_target_id, bid: newBid }] },
                group: "keywords",
              }).catch(e => logger.warn("Rule target bid write-back failed", { error: e.message }));
            }
          }
          applied.push({
            entity_type: entity.entity_type, entity_id: entity.id, expression: entity.expression,
            campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name, action: "adjust_target_bid_pct",
            previous_bid: currentBid, new_bid: newBid,
            change_pct: (pct * 100).toFixed(1) + "%",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos },
          });

        // ── add_negative_keyword ────────────────────────────────────────────
        // action.value: "exact" | "phrase" | "both" (default: "exact")
        // Amazon requires "negativeExact" / "negativePhrase" format
        } else if (action.type === "add_negative_keyword") {
          // Allowed for keywords AND search terms — both write a negative keyword
          // using `entity.keyword_text` (which is the search term `query` for
          // search_term entities, aliased in the SELECT above).
          if (entity.entity_type !== "keyword" && entity.entity_type !== "search_term") {
            recordSkip(entity, action, "wrong_entity_type"); continue;
          }
          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }
          const negMatchTypes = action.value === "phrase" ? ["negativePhrase"]
            : action.value === "both" ? ["negativeExact", "negativePhrase"] : ["negativeExact"];

          // Amazon's report text can carry stray zero-width/no-break characters, so normalize
          // before any inspection of it — otherwise a masked ASIN with an invisible character
          // fails the shape test below and is wrongly negated as a keyword.
          const negKeywordText = normalizeKeywordText(entity.keyword_text);

          // ASIN-shaped search terms (e.g. "b076j8j3w5") are masked ASIN queries.
          // Amazon matches these as products, not keywords — a negative KEYWORD
          // wouldn't actually exclude them. Auto-route to add_negative_target
          // (ASIN-level exclusion) which is what Amazon actually honours.
          const isAsinShaped = /^b0[a-z0-9]{8}$/i.test(negKeywordText || "");
          if (isAsinShaped && entity.entity_type === "search_term") {
            const asinUpper = negKeywordText.toUpperCase();
            const exprUpperJson = JSON.stringify([{ type: "ASIN_SAME_AS", value: asinUpper }]);

            // Skip if ASIN is already an active positive target in the same ad group —
            // Amazon rejects negating a target you're actively bidding on.
            const { rows: activeTgt } = await query(
              `SELECT id FROM targets
               WHERE campaign_id=$1 AND ad_group_id=$2 AND state IN ('enabled','paused')
                 AND (expression @> $3::jsonb OR expression @> $4::jsonb)`,
              [entity.campaign_id, entity.ad_group_id, exprUpperJson,
               JSON.stringify([{ type: "asinSameAs", value: asinUpper }])]
            );
            if (activeTgt.length > 0) { recordSkip(entity, action, "is_active_target"); continue; }

            // Dedup: if this ASIN is already a negative_target anywhere in the
            // campaign (any ad group, or campaign-level), skip — it's already
            // excluded effectively.
            const { rows: dupTgt } = await query(
              `SELECT id, state, ad_group_id, amazon_neg_target_id, writeback_error FROM negative_targets
               WHERE workspace_id=$1 AND campaign_id=$2
                 AND expression @> $3::jsonb`,
              [workspaceId, entity.campaign_id, exprUpperJson]
            );
            if (dupTgt.some(r => r.state === "enabled")) { recordSkip(entity, action, "already_negative"); continue; }
            {
              const priorNt = priorNegTargetRow(dupTgt, entity.ad_group_id);
              if (priorNt && isPermanentWritebackError(priorNt.writeback_error)) {
                recordSkip(entity, action, "amazon_rejected_negative_target", { amazon_error: priorNt.writeback_error });
                continue;
              }
            }

            let insertedNtId = null;
            if (!dryRun) {
              insertedNtId = await claimNegTargetRow(dupTgt, {
                adGroupId: entity.ad_group_id,
                sourceEntityType: entity.entity_type,
                insert: {
                  sql: `INSERT INTO negative_targets
                          (workspace_id, profile_id, campaign_id, ad_group_id,
                           amazon_neg_target_id, expression, expression_type, level,
                           source_rule_id, source_entity_type)
                        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
                        ON CONFLICT DO NOTHING
                        RETURNING id`,
                  params: [workspaceId, entity.profile_db_id, entity.campaign_id, entity.ad_group_id,
                    `rule-neg-asin-${entity.id}`,
                    exprUpperJson, "asinSameAs", "ad_group",
                    rule.id, entity.entity_type],
                },
              });

              const autoRouteAudit = await writeRuleAudit({
                orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
                action: "search_term.add_negative_target_auto", entityType: "search_term",
                // Record the ASIN in the same upper case the matching
                // target.remove_negative_reconcile event uses, so the two correlate. The raw
                // search term arrives lower-cased, which made add/remove pairs for the same
                // ASIN look unrelated in the audit trail.
                entityId: entity.id, entityName: asinUpper,
                beforeData: {},
                afterData: { added_as_negative_target: true, asin: asinUpper, level: "ad_group" },
                source: "rule",
              });

              if (insertedNtId && entity.connection_id) {
                // Reuse the existing v3 POST writer — it already uses the
                // correct uppercase ASIN_SAME_AS, ENABLED state, and updates
                // negative_targets.amazon_neg_target_id with the real Amazon ID.
                trackWriteback(autoRouteAudit, pushNegativeAsin({
                  localId: insertedNtId,
                  connectionId: entity.connection_id,
                  profileId: String(entity.amazon_profile_id),
                  marketplaceId: entity.marketplace_id,
                  campaignType: entity.campaign_type,
                  amazonCampaignId: entity.amazon_campaign_id,
                  amazonAdGroupId: entity.amazon_ad_group_id || null,
                  asinValue: asinUpper,
                  level: "ad_group",
                }), "Rule auto-route negative_target write-back failed",
                  { entity_id: entity.id, entity_type: entity.entity_type, keyword_text: entity.keyword_text, action: "add_negative_target" },
                  rollbackFailedNegative("negative_targets", "amazon_neg_target_id", insertedNtId));
              }
            }

            applied.push({
              entity_type: entity.entity_type, entity_id: entity.id,
              keyword_text: entity.keyword_text,
              expression: [{ type: "ASIN_SAME_AS", value: asinUpper }],
              campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name,
              action: "add_negative_target", auto_routed: true, level: "ad_group",
              metrics: { clicks: entity.clicks, orders: entity.orders, acos: entity.acos, spend: entity.spend },
            });
            continue;
          }

          // Amazon rejects raw report whitespace (U+00A0 between a number and its unit is
          // common in German queries) with PATTERN_NOT_MATCHED. Negate the normalized text —
          // it targets the same traffic and is the only form Amazon accepts.
          if (!negKeywordText) { recordSkip(entity, action, "empty_keyword_text"); continue; }
          // Characters Amazon refuses that normalization must not "fix". Substituting a space
          // for the comma in "abdeckplane wohnmobil 7,50 m" makes a *different* keyword: that
          // query took 6 clicks in August 2026 while a negative_exact for the space-form sat
          // enabled in the same ad group. Negating the substitute would report success for a
          // negative that blocks nothing, then skip the term forever as `already_negative`.
          // Surface it instead, so it can be handled by hand.
          const unsupportedChars = unsupportedKeywordChars(negKeywordText);
          if (unsupportedChars.length) {
            recordSkip(entity, action, "unsupported_keyword_text", {
              keyword_text: negKeywordText, characters: unsupportedChars,
            });
            continue;
          }

          for (const matchType of negMatchTypes) {
            // Normalize match_type: Amazon sync stores "negative_exact"/"negative_phrase" (snake_case)
            // but rule engine uses "negativeExact"/"negativePhrase" (camelCase) — match both.
            // Rows are matched on normalized text so a negative added before this normalization
            // (raw U+00A0 text) is still recognised as the same keyword.
            const { rows: existing } = await query(
              `SELECT id, state, ad_group_id, amazon_neg_keyword_id, writeback_error FROM negative_keywords
               WHERE workspace_id=$1 AND campaign_id=$2
               AND LOWER(${sqlNormalizeKeywordText("keyword_text")})=LOWER(${sqlNormalizeKeywordText("$3")})
               AND REPLACE(LOWER(match_type),'_','') = REPLACE(LOWER($4),'_','')`,
              [workspaceId, entity.campaign_id, negKeywordText, matchType]
            );
            // "Already negative" stays campaign-wide, as before — an enabled negative anywhere
            // in the campaign means the term is handled.
            if (existing.some(r => r.state === "enabled")) { recordSkip(entity, action, "already_negative"); continue; }
            // Re-use is deliberately narrower: only a row for this same ad group describes the
            // same negative, since these are written at ad-group level.
            const priorRow = existing.find(r =>
              String(r.ad_group_id ?? "") === String(entity.ad_group_id ?? "")) || null;
            // Amazon already refused this exact text for a reason that will not change. Report
            // it every run rather than re-issuing the same doomed write — the skip carries the
            // Amazon message, so the term shows up as unnegatable instead of vanishing.
            if (priorRow && isPermanentWritebackError(priorRow.writeback_error)) {
              recordSkip(entity, action, "amazon_rejected_keyword_text", {
                match_type: matchType, keyword_text: negKeywordText, amazon_error: priorRow.writeback_error,
              });
              continue;
            }

            let insertedId = null;
            if (!dryRun) {
              if (priorRow) {
                // An inactive row for this exact negative already exists — typically one this
                // or another rule archived earlier. Re-activate and re-own it instead of
                // inserting a second row.
                //
                // Inserting a new row here is what kept negatives oscillating forever: the
                // write-back's duplicate-recovery re-enables the keyword on Amazon and then
                // deletes its own placeholder row on the unique-index conflict, leaving the
                // *archived* row owned by the rule that removed it. The next sync saw the
                // keyword ENABLED on Amazon and flipped that row back to enabled, so the
                // owning rule archived it again the following day — every day, indefinitely.
                // Re-owning transfers the row to the rule that now justifies the negative, so
                // the removing rule no longer sees it and the loop settles after one cycle.
                //
                // A row archived earlier carries a synthetic id ("archived-…", or "rule-…" if
                // its Amazon write never landed). Reset it to a fresh placeholder keyed on the
                // row's own uuid: it stays unique under (profile_id, amazon_neg_keyword_id),
                // it is correctly recognised as "no Amazon id yet", and the write-back
                // overwrites it with the real id once Amazon accepts the negative.
                const synthetic = isSyntheticNegId(priorRow.amazon_neg_keyword_id);
                await query(
                  // reconcile_miss_count resets: the row is a fresh negative for its new owner,
                  // and inheriting a part-way count would release it early.
                  `UPDATE negative_keywords
                      SET state='enabled', source_rule_id=$1, source_entity_type=$2,
                          keyword_text=$3, reconcile_miss_count=0,
                          writeback_error=NULL, writeback_failed_at=NULL,
                          updated_at=NOW()${synthetic ? ", amazon_neg_keyword_id=$5" : ""}
                    WHERE id=$4`,
                  synthetic
                    ? [rule.id, entity.entity_type, negKeywordText, priorRow.id, `rule-${priorRow.id}-${matchType}`]
                    : [rule.id, entity.entity_type, negKeywordText, priorRow.id]
                );
                insertedId = priorRow.id;
              } else {
                const { rows: insRows } = await query(
                  `INSERT INTO negative_keywords
                     (workspace_id, profile_id, campaign_id, ad_group_id,
                      amazon_neg_keyword_id, keyword_text, match_type, level,
                      source_rule_id, source_entity_type)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, 'ad_group', $8, $9)
                   ON CONFLICT (profile_id, amazon_neg_keyword_id) DO NOTHING
                   RETURNING id`,
                  [workspaceId, entity.profile_db_id, entity.campaign_id, entity.ad_group_id,
                    `rule-${entity.id}-${matchType}`,
                    negKeywordText, matchType.replace(/([A-Z])/g, '_$1').toLowerCase(),
                    rule.id, entity.entity_type]
                );
                insertedId = insRows[0]?.id || null;
              }

              const addNegKwAudit = await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
                action: "keyword.add_negative", entityType: "keyword",
                entityId: entity.id, entityName: entity.keyword_text,
                beforeData: {}, afterData: { match_type: matchType, level: "ad_group", added_as_negative: true },
                source: "rule",
              });

              if (insertedId && entity.connection_id) {
                trackWriteback(addNegKwAudit, pushNegativeKeyword({
                  localId: insertedId,
                  connectionId: entity.connection_id,
                  profileId: String(entity.amazon_profile_id),
                  marketplaceId: entity.marketplace_id,
                  campaignType: entity.campaign_type,
                  amazonCampaignId: entity.amazon_campaign_id,
                  amazonAdGroupId: entity.amazon_ad_group_id || null,
                  keywordText: negKeywordText,
                  matchType,
                  level: "ad_group",
                }), "Rule add_negative_keyword write-back failed",
                  { entity_id: entity.id, entity_type: entity.entity_type, keyword_text: negKeywordText, action: "add_negative_keyword" },
                  rollbackFailedNegative("negative_keywords", "amazon_neg_keyword_id", insertedId));
              }
            }
            applied.push({
              entity_type: entity.entity_type, entity_id: entity.id, keyword_text: entity.keyword_text,
              campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name, action: "add_negative_keyword",
              match_type: matchType, level: "ad_group",
              metrics: { clicks: entity.clicks, orders: entity.orders, acos: entity.acos, spend: entity.spend },
            });
          }

        // ── add_negative_target ─────────────────────────────────────────────
        } else if (action.type === "add_negative_target") {
          if (entity.entity_type !== "target" && entity.entity_type !== "search_term") {
            recordSkip(entity, action, "wrong_entity_type"); continue;
          }

          // search_term entities: only ASIN-shaped queries can become negative targets
          if (entity.entity_type === "search_term") {
            const isAsinShaped = /^b0[a-z0-9]{8}$/i.test(entity.keyword_text || "");
            if (!isAsinShaped) { recordSkip(entity, action, "not_asin_query"); continue; }
            const asinUpper    = entity.keyword_text.toUpperCase();
            const exprUpperJson = JSON.stringify([{ type: "ASIN_SAME_AS", value: asinUpper }]);
            const { rows: dupTgt } = await query(
              `SELECT id, state, ad_group_id, amazon_neg_target_id, writeback_error FROM negative_targets WHERE workspace_id=$1 AND campaign_id=$2 AND expression @> $3::jsonb`,
              [workspaceId, entity.campaign_id, exprUpperJson]
            );
            if (dupTgt.some(r => r.state === "enabled")) { recordSkip(entity, action, "already_negative"); continue; }
            {
              const priorNt = priorNegTargetRow(dupTgt, entity.ad_group_id);
              if (priorNt && isPermanentWritebackError(priorNt.writeback_error)) {
                recordSkip(entity, action, "amazon_rejected_negative_target", { amazon_error: priorNt.writeback_error });
                continue;
              }
            }
            let insertedNtId = null;
            if (!dryRun) {
              insertedNtId = await claimNegTargetRow(dupTgt, {
                adGroupId: entity.ad_group_id,
                sourceEntityType: entity.entity_type,
                insert: {
                  sql: `INSERT INTO negative_targets
                          (workspace_id, profile_id, campaign_id, ad_group_id,
                           amazon_neg_target_id, expression, expression_type, level,
                           source_rule_id, source_entity_type)
                        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
                        ON CONFLICT DO NOTHING RETURNING id`,
                  params: [workspaceId, entity.profile_db_id, entity.campaign_id, entity.ad_group_id,
                    `rule-neg-asin-st-${entity.id}`, exprUpperJson, "asinSameAs", "ad_group",
                    rule.id, entity.entity_type],
                },
              });
              const addNegTgtStAudit = await writeRuleAudit({
                orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
                action: "search_term.add_negative_target", entityType: "search_term",
                entityId: entity.id, entityName: asinUpper,   // upper case — see auto_route above
                beforeData: {}, afterData: { added_as_negative_target: true, asin: asinUpper },
                source: "rule",
              });
              if (insertedNtId && entity.connection_id) {
                trackWriteback(addNegTgtStAudit, pushNegativeAsin({
                  localId: insertedNtId, connectionId: entity.connection_id,
                  profileId: String(entity.amazon_profile_id), marketplaceId: entity.marketplace_id,
                  campaignType: entity.campaign_type, amazonCampaignId: entity.amazon_campaign_id,
                  amazonAdGroupId: entity.amazon_ad_group_id || null,
                  asinValue: asinUpper, level: "ad_group",
                }), "Rule add_neg_target ST write-back failed",
                  { entity_id: entity.id, entity_type: entity.entity_type, keyword_text: entity.keyword_text, action: "add_negative_target" },
                  rollbackFailedNegative("negative_targets", "amazon_neg_target_id", insertedNtId));
              }
            }
            applied.push({
              entity_type: "search_term", entity_id: entity.id,
              keyword_text: entity.keyword_text,
              expression: [{ type: "ASIN_SAME_AS", value: asinUpper }],
              campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name,
              action: "add_negative_target", auto_routed: true, level: "ad_group",
              metrics: { clicks: entity.clicks, orders: entity.orders, acos: entity.acos, spend: entity.spend },
            });
            continue;
          }

          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }

          // QUERY_HIGH/BROAD_REL_MATCHES are auto-targeting clauses — Amazon has
          // no "negative query" concept. Instead, drill into search_term_metrics
          // for this campaign/ad_group during the rule period, find ASIN queries,
          // and add each as an ASIN_SAME_AS negative target.
          const exprArrRaw = (() => {
            try { return Array.isArray(entity.expression) ? entity.expression : JSON.parse(entity.expression || "[]"); }
            catch { return []; }
          })();
          const exprType0 = (exprArrRaw[0]?.type || "").toUpperCase();
          const isQueryAutoType = exprType0 === "QUERY_BROAD_REL_MATCHES" || exprType0 === "QUERY_HIGH_REL_MATCHES";

          // Only ASIN_SAME_AS and ASIN_BRAND_SAME_AS are valid negative target expression types.
          // Other auto-targeting types (KEYWORD_GROUP_SAME_AS, ASIN_SUBSTITUTE_RELATED, etc.)
          // are handled above (query types) or cannot be negated — skip them.
          const VALID_NEG_TARGET_TYPES = new Set(["ASIN_SAME_AS", "ASIN_BRAND_SAME_AS"]);
          if (!isQueryAutoType && exprType0 && !VALID_NEG_TARGET_TYPES.has(exprType0)) {
            recordSkip(entity, action, "non_negatable_expression_type"); continue;
          }

          if (isQueryAutoType) {
            // Fetch ASIN queries with their own search-term metrics (not target-level aggregates)
            const { rows: asinTerms } = await query(
              `SELECT UPPER(stm.query)        AS asin,
                      SUM(stm.clicks)         AS st_clicks,
                      SUM(stm.spend)          AS st_spend,
                      SUM(stm.orders)         AS st_orders,
                      CASE WHEN SUM(stm.sales) > 0
                           THEN SUM(stm.spend)/SUM(stm.sales)*100 END AS st_acos
               FROM search_term_metrics stm
               WHERE stm.workspace_id = $1
                 AND stm.campaign_id  = $2
                 AND stm.ad_group_id  = $3
                 AND stm.date_start  >= $4
                 AND stm.date_end    <= $5
                 AND stm.query       ~* '^B0[A-Z0-9]{8,9}$'
               GROUP BY stm.query`,
              [workspaceId, entity.campaign_id, entity.ad_group_id, startDate, endDate]
            );
            if (!asinTerms.length) { recordSkip(entity, action, "no_asin_search_terms"); continue; }

            for (const asinRow of asinTerms) {
              const asinUpper = asinRow.asin;
              const exprUpperJson = JSON.stringify([{ type: "ASIN_SAME_AS", value: asinUpper }]);
              const { rows: dupTgt } = await query(
                `SELECT id, state, ad_group_id, amazon_neg_target_id, writeback_error FROM negative_targets
                 WHERE workspace_id=$1 AND campaign_id=$2 AND expression @> $3::jsonb`,
                [workspaceId, entity.campaign_id, exprUpperJson]
              );
              if (dupTgt.some(r => r.state === "enabled")) { recordSkip(entity, action, "already_negative"); continue; }
              {
                const priorNt = priorNegTargetRow(dupTgt, entity.ad_group_id);
                if (priorNt && isPermanentWritebackError(priorNt.writeback_error)) {
                  recordSkip(entity, action, "amazon_rejected_negative_target", { amazon_error: priorNt.writeback_error });
                  continue;
                }
              }

              let insertedNtId = null;
              if (!dryRun) {
                insertedNtId = await claimNegTargetRow(dupTgt, {
                  adGroupId: entity.ad_group_id,
                  sourceEntityType: entity.entity_type,
                  insert: {
                    sql: `INSERT INTO negative_targets
                            (workspace_id, profile_id, campaign_id, ad_group_id,
                             amazon_neg_target_id, expression, expression_type, level,
                             source_rule_id, source_entity_type)
                          VALUES ($1,
                            (SELECT profile_id FROM campaigns WHERE id=$2 LIMIT 1),
                            $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
                          ON CONFLICT DO NOTHING
                          RETURNING id`,
                    params: [workspaceId, entity.campaign_id, entity.ad_group_id,
                      `rule-neg-asin-qt-${entity.id}-${asinUpper}`,
                      exprUpperJson, "asinSameAs", "ad_group",
                      rule.id, entity.entity_type],
                  },
                });

                const addNegQtAudit = await writeRuleAudit({
                  orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
                  action: "target.add_negative_asin_via_query", entityType: "target",
                  entityId: entity.id, entityName: `${exprType0} → ASIN_SAME_AS:${asinUpper}`,
                  beforeData: {}, afterData: { added_as_negative_target: true, asin: asinUpper, auto_routed: true },
                  source: "rule",
                });

                if (insertedNtId && entity.connection_id) {
                  trackWriteback(addNegQtAudit, pushNegativeAsin({
                    localId: insertedNtId,
                    connectionId: entity.connection_id,
                    profileId: String(entity.amazon_profile_id),
                    marketplaceId: entity.marketplace_id,
                    campaignType: entity.campaign_type,
                    amazonCampaignId: entity.amazon_campaign_id,
                    amazonAdGroupId: entity.amazon_ad_group_id || null,
                    asinValue: asinUpper,
                    level: "ad_group",
                  }), "Rule query-type neg_target write-back failed",
                    { entity_id: entity.id, entity_type: entity.entity_type, keyword_text: entity.keyword_text, action: "add_negative_target" },
                    rollbackFailedNegative("negative_targets", "amazon_neg_target_id", insertedNtId));
                }
              }
              applied.push({
                entity_type: "search_term",
                entity_id: entity.id,
                keyword_text: asinUpper,
                expression: [{ type: "ASIN_SAME_AS", value: asinUpper }],
                campaign_name: entity.campaign_name,
                ad_group_name: entity.ad_group_name,
                action: "add_negative_target",
                auto_routed: true, level: "ad_group",
                metrics: {
                  clicks: asinRow.st_clicks,
                  orders: asinRow.st_orders,
                  acos:   asinRow.st_acos,
                  spend:  asinRow.st_spend,
                },
              });
            }
            continue; // entity loop — query-type fully handled above
          }

          const exprJson = typeof entity.expression === "string"
            ? entity.expression : JSON.stringify(entity.expression);

          const { rows: existing } = await query(
            `SELECT id, state, ad_group_id, amazon_neg_target_id, writeback_error FROM negative_targets
             WHERE workspace_id=$1 AND campaign_id=$2 AND ad_group_id=$3 AND expression=$4::jsonb`,
            [workspaceId, entity.campaign_id, entity.ad_group_id, exprJson]
          );
          if (existing.some(r => r.state === "enabled")) { recordSkip(entity, action, "already_negative"); continue; }
          {
            const priorNt = priorNegTargetRow(existing, entity.ad_group_id);
            if (priorNt && isPermanentWritebackError(priorNt.writeback_error)) {
              recordSkip(entity, action, "amazon_rejected_negative_target", { amazon_error: priorNt.writeback_error });
              continue;
            }
          }

          let insertedNtId = null;
          if (!dryRun) {
            insertedNtId = await claimNegTargetRow(existing, {
              adGroupId: entity.ad_group_id,
              sourceEntityType: entity.entity_type,
              insert: {
                sql: `INSERT INTO negative_targets
                        (workspace_id, profile_id, campaign_id, ad_group_id,
                         amazon_neg_target_id, expression, expression_type, level,
                         source_rule_id, source_entity_type)
                      VALUES ($1,
                        (SELECT profile_id FROM campaigns WHERE id=$2 LIMIT 1),
                        $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
                      ON CONFLICT DO NOTHING
                      RETURNING id`,
                params: [workspaceId, entity.campaign_id, entity.ad_group_id,
                  `rule-neg-${entity.id}`,
                  exprJson, entity.expression_type || "asinSameAs", "ad_group",
                  rule.id, entity.entity_type],
              },
            });

            const addNegTgtAudit = await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "target.add_negative", entityType: "target",
              entityId: entity.id, entityName: JSON.stringify(entity.expression),
              beforeData: {}, afterData: { added_as_negative: true }, source: "rule",
            });

            if (insertedNtId && entity.connection_id) {
              const targetExpr = typeof entity.expression === "string"
                ? JSON.parse(entity.expression) : entity.expression;
              // Was an inline fire-and-forget post(): it resolved "success" whenever the HTTP
              // call did not throw, so a 207 rejection (no id in the body) was recorded as a
              // clean write, and executeRule could return before Amazon had answered at all.
              trackWriteback(addNegTgtAudit, pushNegativeTarget({
                localId: insertedNtId,
                connectionId: entity.connection_id,
                profileId: String(entity.amazon_profile_id),
                marketplaceId: entity.marketplace_id,
                campaignType: entity.campaign_type,
                amazonCampaignId: entity.amazon_campaign_id,
                amazonAdGroupId: entity.amazon_ad_group_id || null,
                expression: targetExpr,
                level: "ad_group",
              }), "Rule add_negative_target write-back failed",
                { entity_id: entity.id, entity_type: entity.entity_type, keyword_text: null, action: "add_negative_target" },
                rollbackFailedNegative("negative_targets", "amazon_neg_target_id", insertedNtId));
            }
          }
          applied.push({
            entity_type: entity.entity_type, entity_id: entity.id, expression: entity.expression,
            campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name, action: "add_negative_target",
            metrics: { clicks: entity.clicks, orders: entity.orders, spend: entity.spend, acos: entity.acos },
          });

        // ── pause_ad_group ──────────────────────────────────────────────────
        } else if (action.type === "pause_ad_group") {
          if (entity.entity_type !== "ad_group") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "paused") { recordSkip(entity, action, "already_paused"); continue; }
          if (!dryRun) {
            await query("UPDATE ad_groups SET state = 'paused', updated_at = NOW() WHERE id = $1", [entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "ad_group.pause", entityType: "ad_group",
              entityId: entity.id, entityName: entity.ad_group_name,
              beforeData: { state: entity.state }, afterData: { state: "paused" }, source: "rule",
            });
            if (entity.amazon_ag_id && entity.connection_id) {
              const agPath = entity.campaign_type === "sponsoredDisplay" ? "/sd/adGroups"
                           : entity.campaign_type === "sponsoredBrands"  ? "/sb/adGroups"
                           : "/sp/adGroups";
              put({ connectionId: entity.connection_id, profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id, path: agPath,
                data: { adGroups: [{ adGroupId: entity.amazon_ag_id, state: "PAUSED" }] }, group: "ad_groups",
              }).catch(e => logger.warn("Rule ad_group pause write-back failed", { error: e.message }));
            }
          }
          applied.push({ entity_type: "ad_group", entity_id: entity.id, keyword_text: entity.ad_group_name,
            campaign_name: entity.campaign_name, action: "pause_ad_group",
            previous_state: entity.state, new_state: "paused",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos } });

        // ── enable_ad_group ─────────────────────────────────────────────────
        } else if (action.type === "enable_ad_group") {
          if (entity.entity_type !== "ad_group") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "enabled") { recordSkip(entity, action, "already_enabled"); continue; }
          if (!dryRun) {
            await query("UPDATE ad_groups SET state = 'enabled', updated_at = NOW() WHERE id = $1", [entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "ad_group.enable", entityType: "ad_group",
              entityId: entity.id, entityName: entity.ad_group_name,
              beforeData: { state: entity.state }, afterData: { state: "enabled" }, source: "rule",
            });
            if (entity.amazon_ag_id && entity.connection_id) {
              const agPath = entity.campaign_type === "sponsoredDisplay" ? "/sd/adGroups"
                           : entity.campaign_type === "sponsoredBrands"  ? "/sb/adGroups"
                           : "/sp/adGroups";
              put({ connectionId: entity.connection_id, profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id, path: agPath,
                data: { adGroups: [{ adGroupId: entity.amazon_ag_id, state: "ENABLED" }] }, group: "ad_groups",
              }).catch(e => logger.warn("Rule ad_group enable write-back failed", { error: e.message }));
            }
          }
          applied.push({ entity_type: "ad_group", entity_id: entity.id, keyword_text: entity.ad_group_name,
            campaign_name: entity.campaign_name, action: "enable_ad_group",
            previous_state: entity.state, new_state: "enabled",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos } });

        // ── adjust_default_bid_pct ──────────────────────────────────────────
        } else if (action.type === "adjust_default_bid_pct") {
          if (entity.entity_type !== "ad_group") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }
          const pct        = parseFloat(action.value || 0) / 100;
          const currentBid = parseFloat(entity.default_bid || 0.30);
          const minBid     = parseFloat(safety.min_bid || 0.02);
          const maxBid     = parseFloat(safety.max_bid || 50);
          const newBid     = Math.round(Math.max(minBid, Math.min(maxBid, currentBid * (1 + pct))) * 100) / 100;
          if (!dryRun) {
            await query("UPDATE ad_groups SET default_bid = $1, updated_at = NOW() WHERE id = $2", [newBid, entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "ad_group.adjust_default_bid_pct", entityType: "ad_group",
              entityId: entity.id, entityName: entity.ad_group_name,
              beforeData: { default_bid: currentBid }, afterData: { default_bid: newBid }, source: "rule",
            });
            if (entity.amazon_ag_id && entity.connection_id) {
              const agPath = entity.campaign_type === "sponsoredDisplay" ? "/sd/adGroups"
                           : entity.campaign_type === "sponsoredBrands"  ? "/sb/adGroups"
                           : "/sp/adGroups";
              put({ connectionId: entity.connection_id, profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id, path: agPath,
                data: { adGroups: [{ adGroupId: entity.amazon_ag_id, defaultBid: newBid }] }, group: "ad_groups",
              }).catch(e => logger.warn("Rule ad_group bid write-back failed", { error: e.message }));
            }
          }
          applied.push({ entity_type: "ad_group", entity_id: entity.id, keyword_text: entity.ad_group_name,
            campaign_name: entity.campaign_name, action: "adjust_default_bid_pct",
            previous_bid: currentBid, new_bid: newBid, change_pct: (pct * 100).toFixed(1) + "%",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos } });

        // ── set_default_bid ─────────────────────────────────────────────────
        } else if (action.type === "set_default_bid") {
          if (entity.entity_type !== "ad_group") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }
          const currentBid  = parseFloat(entity.default_bid || 0);
          const minBid      = parseFloat(safety.min_bid || 0.02);
          const maxBid      = parseFloat(safety.max_bid || 50);
          const newBid      = Math.round(Math.max(minBid, Math.min(maxBid, parseFloat(action.value || 0.30))) * 100) / 100;
          if (!dryRun) {
            await query("UPDATE ad_groups SET default_bid = $1, updated_at = NOW() WHERE id = $2", [newBid, entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "ad_group.set_default_bid", entityType: "ad_group",
              entityId: entity.id, entityName: entity.ad_group_name,
              beforeData: { default_bid: currentBid }, afterData: { default_bid: newBid }, source: "rule",
            });
            if (entity.amazon_ag_id && entity.connection_id) {
              const agPath = entity.campaign_type === "sponsoredDisplay" ? "/sd/adGroups"
                           : entity.campaign_type === "sponsoredBrands"  ? "/sb/adGroups"
                           : "/sp/adGroups";
              put({ connectionId: entity.connection_id, profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id, path: agPath,
                data: { adGroups: [{ adGroupId: entity.amazon_ag_id, defaultBid: newBid }] }, group: "ad_groups",
              }).catch(e => logger.warn("Rule ad_group set_bid write-back failed", { error: e.message }));
            }
          }
          applied.push({ entity_type: "ad_group", entity_id: entity.id, keyword_text: entity.ad_group_name,
            campaign_name: entity.campaign_name, action: "set_default_bid",
            previous_bid: currentBid, new_bid: newBid,
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos } });

        // ── pause_campaign ──────────────────────────────────────────────────
        } else if (action.type === "pause_campaign") {
          if (entity.entity_type !== "campaign") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "paused") { recordSkip(entity, action, "already_paused"); continue; }
          if (!dryRun) {
            await query("UPDATE campaigns SET state = 'paused', updated_at = NOW() WHERE id = $1", [entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "campaign.pause", entityType: "campaign",
              entityId: entity.id, entityName: entity.campaign_name,
              beforeData: { state: entity.state }, afterData: { state: "paused" }, source: "rule",
            });
            if (entity.amazon_campaign_id && entity.connection_id) {
              const isSD = entity.campaign_type === "sponsoredDisplay";
              const campPath = campaignApiPath(entity.campaign_type);
              // SD (v2-style) takes a bare array with a lowercase state; SP/SB take the wrapped uppercase form.
              const stateData = isSD
                ? [{ campaignId: entity.amazon_campaign_id, state: "paused" }]
                : { campaigns: [{ campaignId: entity.amazon_campaign_id, state: "PAUSED" }] };
              put({ connectionId: entity.connection_id, profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id, path: campPath,
                data: stateData, group: "campaigns",
              }).catch(e => logger.warn("Rule campaign pause write-back failed", { error: e.message }));
            }
          }
          applied.push({ entity_type: "campaign", entity_id: entity.id, keyword_text: entity.campaign_name,
            campaign_name: null, action: "pause_campaign",
            previous_state: entity.state, new_state: "paused",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos } });

        // ── enable_campaign ─────────────────────────────────────────────────
        } else if (action.type === "enable_campaign") {
          if (entity.entity_type !== "campaign") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "enabled") { recordSkip(entity, action, "already_enabled"); continue; }
          if (!dryRun) {
            await query("UPDATE campaigns SET state = 'enabled', updated_at = NOW() WHERE id = $1", [entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "campaign.enable", entityType: "campaign",
              entityId: entity.id, entityName: entity.campaign_name,
              beforeData: { state: entity.state }, afterData: { state: "enabled" }, source: "rule",
            });
            if (entity.amazon_campaign_id && entity.connection_id) {
              const isSD = entity.campaign_type === "sponsoredDisplay";
              const campPath = campaignApiPath(entity.campaign_type);
              // SD (v2-style) takes a bare array with a lowercase state; SP/SB take the wrapped uppercase form.
              const stateData = isSD
                ? [{ campaignId: entity.amazon_campaign_id, state: "enabled" }]
                : { campaigns: [{ campaignId: entity.amazon_campaign_id, state: "ENABLED" }] };
              put({ connectionId: entity.connection_id, profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id, path: campPath,
                data: stateData, group: "campaigns",
              }).catch(e => logger.warn("Rule campaign enable write-back failed", { error: e.message }));
            }
          }
          applied.push({ entity_type: "campaign", entity_id: entity.id, keyword_text: entity.campaign_name,
            campaign_name: null, action: "enable_campaign",
            previous_state: entity.state, new_state: "enabled",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos } });

        // ── adjust_budget_pct ───────────────────────────────────────────────
        } else if (action.type === "adjust_budget_pct") {
          if (entity.entity_type !== "campaign") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }
          const pct           = parseFloat(action.value || 0) / 100;
          // An unknown budget must never be assumed. This used to read
          // `entity.daily_budget || 10`, so a campaign whose budget the sync had not
          // stored was treated as €10 and "raised by 20%" to €12 — a campaign really
          // running on €50 would have been cut by 76% while the journal recorded a
          // raise. NULL budgets are not hypothetical: the SB/SD parse bug fixed in
          // entities.js left 221 campaigns without one. Skip instead of guessing;
          // the next sync fills the budget in and the rule picks it up.
          const currentBudget = parseFloat(entity.daily_budget);
          if (!Number.isFinite(currentBudget) || currentBudget <= 0) {
            recordSkip(entity, action, "unknown_budget"); continue;
          }
          // Only raise a budget that is actually binding — see the BUDGET_UTILIZATION_*
          // constants. Set min_budget_utilization to 0 to opt out and raise unconditionally.
          const minUtilization = safety?.min_budget_utilization === undefined
            || safety?.min_budget_utilization === null
            || safety?.min_budget_utilization === ""
            ? DEFAULT_MIN_BUDGET_UTILIZATION
            : parseFloat(safety.min_budget_utilization);
          if (Number.isFinite(minUtilization) && minUtilization > 0) {
            const dailySpend  = recentDailySpend.get(entity.amazon_campaign_id) || [];
            const limitedDays = budgetLimitedDays(dailySpend, currentBudget, minUtilization);
            if (limitedDays < MIN_BUDGET_LIMITED_DAYS) {
              recordSkip(entity, action, "budget_not_binding", {
                daily_budget: currentBudget,
                max_daily_spend: dailySpend.length ? Math.max(...dailySpend) : 0,
                budget_limited_days: limitedDays,
                required_days: MIN_BUDGET_LIMITED_DAYS,
                utilization_pct: minUtilization,
                lookback_days: BUDGET_UTILIZATION_LOOKBACK_DAYS,
              });
              continue;
            }
          }
          const maxBudget     = safety?.max_budget ? parseFloat(safety.max_budget) : null;
          // max_budget caps GROWTH — it must never pull a budget down. A plain
          // Math.min(raised, cap) would cut a campaign already above the cap on the very first
          // run (e.g. 350 → 100 under a cap of 100), turning a "+20%" rule into a 71% cut of the
          // account's biggest spender. Clamping back to currentBudget keeps an over-cap campaign
          // exactly where it is; use set_budget when a deliberate reduction is the intent.
          const raised        = Math.max(1, currentBudget * (1 + pct));
          const capped        = Math.min(raised, maxBudget ?? Infinity);
          const newBudget     = Math.round(Math.max(capped, currentBudget) * 100) / 100;
          // Already at or over the cap: nothing to change. Writing anyway would put a 350 → 350
          // no-op in the audit journal every run and spend an Amazon call on it.
          if (newBudget === currentBudget) { recordSkip(entity, action, "at_max_budget"); continue; }
          if (!dryRun) {
            await query("UPDATE campaigns SET daily_budget = $1, updated_at = NOW() WHERE id = $2", [newBudget, entity.id]);
            const adjustBudgetAudit = await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "campaign.adjust_budget_pct", entityType: "campaign",
              entityId: entity.id, entityName: entity.campaign_name,
              beforeData: { daily_budget: currentBudget }, afterData: { daily_budget: newBudget }, source: "rule",
            });
            if (entity.amazon_campaign_id && entity.connection_id) {
              trackWriteback(adjustBudgetAudit, pushCampaignUpdates([{
                amazonCampaignId: entity.amazon_campaign_id,
                campaignType:     entity.campaign_type,
                connectionId:     entity.connection_id,
                profileId:        String(entity.amazon_profile_id),
                marketplaceId:    entity.marketplace_id,
                dailyBudget:      newBudget,
              }]), "Rule campaign budget write-back failed",
                { entity_id: entity.id, entity_type: entity.entity_type, keyword_text: entity.campaign_name, action: "adjust_budget_pct" });
            }
          }
          applied.push({ entity_type: "campaign", entity_id: entity.id, keyword_text: entity.campaign_name,
            campaign_name: null, action: "adjust_budget_pct",
            previous_budget: currentBudget, new_budget: newBudget, change_pct: (pct * 100).toFixed(1) + "%",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos } });

        // ── set_budget ──────────────────────────────────────────────────────
        } else if (action.type === "set_budget") {
          if (entity.entity_type !== "campaign") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }
          // set_budget writes an absolute value, so an unknown current budget is not a
          // hazard the way it is for the percentage action — it only affects what the
          // journal records as the "before". Keep it null rather than inventing a 0,
          // so a rollback can tell "was 0" from "we never knew".
          const currentBudget = Number.isFinite(parseFloat(entity.daily_budget)) ? parseFloat(entity.daily_budget) : null;
          const maxBudget     = safety?.max_budget ? parseFloat(safety.max_budget) : null;
          const newBudget     = Math.round(Math.min(Math.max(1, parseFloat(action.value || 10)), maxBudget ?? Infinity) * 100) / 100;
          if (!dryRun) {
            await query("UPDATE campaigns SET daily_budget = $1, updated_at = NOW() WHERE id = $2", [newBudget, entity.id]);
            const setBudgetAudit = await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "campaign.set_budget", entityType: "campaign",
              entityId: entity.id, entityName: entity.campaign_name,
              beforeData: { daily_budget: currentBudget }, afterData: { daily_budget: newBudget }, source: "rule",
            });
            if (entity.amazon_campaign_id && entity.connection_id) {
              trackWriteback(setBudgetAudit, pushCampaignUpdates([{
                amazonCampaignId: entity.amazon_campaign_id,
                campaignType:     entity.campaign_type,
                connectionId:     entity.connection_id,
                profileId:        String(entity.amazon_profile_id),
                marketplaceId:    entity.marketplace_id,
                dailyBudget:      newBudget,
              }]), "Rule campaign set_budget write-back failed",
                { entity_id: entity.id, entity_type: entity.entity_type, keyword_text: entity.campaign_name, action: "set_budget" });
            }
          }
          applied.push({ entity_type: "campaign", entity_id: entity.id, keyword_text: entity.campaign_name,
            campaign_name: null, action: "set_budget",
            previous_budget: currentBudget, new_budget: newBudget,
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos } });
        }
      } catch (e) {
        errors.push({ entity_id: entity.id, error: e.message });
      }
    }
  }

  // Let every write-back fired during the main pass above (adds, budget/bid changes, etc.)
  // finish before reconciliation reads negative_keywords/negative_targets below — otherwise a
  // still-in-flight duplicate-add recovery can delete a row out from under an archive this
  // reconciliation pass just committed (see pendingWritebacks comment above).
  await Promise.all(pendingWritebacks);

  // ── Reconciliation: un-negate previously negated items whose conditions no longer hold ──
  // Only applies to negatives created by this rule (source_rule_id = rule.id).
  // For each active negative: re-evaluate the same conditions against current metrics.
  // If conditions are NOT met → the term now converts or no longer qualifies → remove negative.
  const removed = [];
  // Consecutive unjustified runs required before a negative is actually released.
  const reconcileGraceRuns = Math.max(
    1, parseInt(safety?.reconcile_grace_runs, 10) || RECONCILE_GRACE_RUNS_DEFAULT
  );
  {
    const { rows: prevNegKws } = await query(
      `SELECT nk.id, nk.keyword_text, nk.campaign_id, nk.ad_group_id,
              nk.amazon_neg_keyword_id, nk.match_type, nk.level, nk.source_entity_type,
              nk.reconcile_miss_count,
              p.profile_id AS amazon_profile_id, p.connection_id, p.marketplace_id,
              c.campaign_type, c.name AS campaign_name
       FROM negative_keywords nk
       JOIN campaigns c        ON c.id  = nk.campaign_id
       JOIN amazon_profiles p  ON p.id  = nk.profile_id
       WHERE nk.source_rule_id = $1 AND nk.workspace_id = $2 AND nk.state = 'enabled'`,
      [rule.id, workspaceId]
    );

    for (const nk of prevNegKws) {
      let m = { clicks: 0, spend: 0, orders: 0, sales: 0, impressions: 0 };
      // Slices evaluated at the add path's granularity; a negative survives if ANY of them
      // still satisfies the rule (see the search_term branch below). Null means "not sliced"
      // — the single aggregate in `m` decides, as before.
      let slices = null;
      if (nk.source_entity_type === "search_term") {
        // Re-evaluate at exactly the granularity the add path used — per (ad_group, match_type)
        // slice of this ad group — and keep the negative if ANY slice still qualifies.
        //
        // This previously aggregated campaign-wide, across every ad group and match type. The
        // add path groups by (query, campaign, ad_group, match_type), so the two routinely
        // disagreed and the rule removed on one run what it had added on the one before. Live
        // example: "campingstuhl 150 kg" scored 25 clicks / 1 order on the BROAD slice the add
        // path saw (rule matched), but 29 clicks / 2 orders campaign-wide, which failed the
        // `orders = 1` condition — so every run added it and then immediately removed it again.
        // An ad-group-level negative only blocks its own ad group, so the ad-group view is also
        // the one that reflects what the negative actually does.
        //
        // Text is compared normalized on both sides: negatives are stored normalized (Amazon
        // rejects the raw text) while search_term_metrics.query keeps Amazon's original
        // typographic whitespace.
        const stParams = [workspaceId, nk.campaign_id, nk.keyword_text, startDate, endDate];
        let agClause = "";
        if (nk.ad_group_id) { stParams.push(nk.ad_group_id); agClause = ` AND ad_group_id = $${stParams.length}`; }
        const { rows } = await query(
          `SELECT COALESCE(SUM(clicks),0) AS clicks, COALESCE(SUM(spend),0) AS spend,
                  COALESCE(SUM(orders),0) AS orders, COALESCE(SUM(sales),0) AS sales,
                  COALESCE(SUM(impressions),0) AS impressions
           FROM search_term_metrics
           WHERE workspace_id=$1 AND campaign_id=$2
             AND LOWER(${sqlNormalizeKeywordText("query")})=LOWER(${sqlNormalizeKeywordText("$3")})
             AND date_start>=$4 AND date_end<=$5${agClause}
           GROUP BY ad_group_id, match_type`,
          stParams
        );
        slices = rows.map(withDerivedMetrics);
        // Keep the aggregate for reporting even when slices decide the outcome.
        m = slices.length
          ? slices.reduce((acc, s) => ({
              clicks:      Number(acc.clicks)      + Number(s.clicks),
              spend:       Number(acc.spend)       + Number(s.spend),
              orders:      Number(acc.orders)      + Number(s.orders),
              sales:       Number(acc.sales)       + Number(s.sales),
              impressions: Number(acc.impressions) + Number(s.impressions),
            }), m)
          : m;
      } else {
        const { rows } = await query(
          `SELECT COALESCE(SUM(m.clicks),0) AS clicks, COALESCE(SUM(m.cost),0) AS spend,
                  COALESCE(SUM(m.orders_14d),0) AS orders, COALESCE(SUM(m.sales_14d),0) AS sales,
                  COALESCE(SUM(m.impressions),0) AS impressions
           FROM keywords k
           LEFT JOIN fact_metrics_daily m ON m.amazon_id = k.amazon_keyword_id
             AND m.entity_type = 'keyword' AND m.date BETWEEN $4 AND $5
           WHERE k.workspace_id=$1 AND k.campaign_id=$2 AND LOWER(k.keyword_text)=LOWER($3)`,
          [workspaceId, nk.campaign_id, nk.keyword_text, startDate, endDate]
        );
        if (rows[0]) m = rows[0];
      }
      withDerivedMetrics(m);

      const releaseNegKw = await confirmReconcileRelease({
        table: "negative_keywords", id: nk.id, missCount: nk.reconcile_miss_count,
        justified: negativeStillJustified(metricConditions, m, slices),
        graceRuns: reconcileGraceRuns, dryRun,
      });
      if (releaseNegKw) {
        removed.push({
          type: "keyword", id: nk.id, keyword_text: nk.keyword_text,
          campaign_name: nk.campaign_name, action: "remove_negative_reconcile",
          metrics: { clicks: m.clicks, orders: m.orders, spend: m.spend, acos: m.acos },
        });
        if (!dryRun) {
          // Free the placeholder ID so the rule can re-negate later if needed
          const newAmazonId = isSyntheticNegId(nk.amazon_neg_keyword_id)
            ? `archived-${Date.now()}-${nk.id}` : nk.amazon_neg_keyword_id;
          await query(
            "UPDATE negative_keywords SET state='archived', amazon_neg_keyword_id=$1 WHERE id=$2",
            [newAmazonId, nk.id]
          );
          const reconcileNegKwAudit = await writeRuleAudit({
            orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
            action: "keyword.remove_negative_reconcile", entityType: "keyword",
            entityId: nk.id, entityName: nk.keyword_text,
            beforeData: { state: "enabled" },
            afterData: { state: "archived", reason: "conditions_no_longer_met", metrics: m },
            source: "rule",
          });
          // "archived-…" ids are synthetic too — sending one to Amazon as an entity id fails.
          const hasRealId = !isSyntheticNegId(nk.amazon_neg_keyword_id);
          if (hasRealId && nk.connection_id) {
            trackWriteback(reconcileNegKwAudit, archiveNegativeKeyword({
              connectionId: nk.connection_id, profileId: String(nk.amazon_profile_id),
              marketplaceId: nk.marketplace_id, campaignType: nk.campaign_type,
              level: nk.level, amazonNegKeywordId: nk.amazon_neg_keyword_id,
            }), "Reconcile archive neg_kw failed",
              { entity_id: nk.id, entity_type: "negative_keyword", keyword_text: nk.keyword_text, action: "remove_negative_reconcile" });
          }
        }
      }
    }

    const { rows: prevNegTgts } = await query(
      `SELECT nt.id, nt.expression, nt.campaign_id, nt.ad_group_id,
              nt.amazon_neg_target_id, nt.level, nt.source_entity_type,
              nt.reconcile_miss_count,
              p.profile_id AS amazon_profile_id, p.connection_id, p.marketplace_id,
              c.campaign_type, c.name AS campaign_name
       FROM negative_targets nt
       JOIN campaigns c        ON c.id  = nt.campaign_id
       JOIN amazon_profiles p  ON p.id  = nt.profile_id
       WHERE nt.source_rule_id = $1 AND nt.workspace_id = $2 AND nt.state = 'enabled'`,
      [rule.id, workspaceId]
    );

    for (const nt of prevNegTgts) {
      let m = { clicks: 0, spend: 0, orders: 0, sales: 0, impressions: 0 };
      let slices = null;
      const exprArr = typeof nt.expression === "string"
        ? JSON.parse(nt.expression || "[]") : (nt.expression || []);
      const asinValue = exprArr.find(e =>
        e.type === "ASIN_SAME_AS" || e.type === "asinSameAs"
      )?.value;

      if (asinValue) {
        // Same granularity alignment as the negative-keyword branch above: the add path
        // groups masked-ASIN search terms by (query, campaign, ad_group, match_type), so
        // reconciliation has to as well, or it removes what the next run re-adds.
        const stParams = [workspaceId, nt.campaign_id, asinValue, startDate, endDate];
        let agClause = "";
        if (nt.ad_group_id) { stParams.push(nt.ad_group_id); agClause = ` AND ad_group_id = $${stParams.length}`; }
        const { rows } = await query(
          `SELECT COALESCE(SUM(clicks),0) AS clicks, COALESCE(SUM(spend),0) AS spend,
                  COALESCE(SUM(orders),0) AS orders, COALESCE(SUM(sales),0) AS sales,
                  COALESCE(SUM(impressions),0) AS impressions
           FROM search_term_metrics
           WHERE workspace_id=$1 AND campaign_id=$2
             AND UPPER(query)=UPPER($3) AND date_start>=$4 AND date_end<=$5${agClause}
           GROUP BY ad_group_id, match_type`,
          stParams
        );
        slices = rows.map(withDerivedMetrics);
        m = slices.length
          ? slices.reduce((acc, s) => ({
              clicks:      Number(acc.clicks)      + Number(s.clicks),
              spend:       Number(acc.spend)       + Number(s.spend),
              orders:      Number(acc.orders)      + Number(s.orders),
              sales:       Number(acc.sales)       + Number(s.sales),
              impressions: Number(acc.impressions) + Number(s.impressions),
            }), m)
          : m;
      } else {
        // Non-ASIN negative (category, audience) — no query-level metrics available.
        // Skip reconciliation: leave these negatives in place rather than risk false removal.
        continue;
      }
      withDerivedMetrics(m);

      const releaseNegTgt = await confirmReconcileRelease({
        table: "negative_targets", id: nt.id, missCount: nt.reconcile_miss_count,
        justified: negativeStillJustified(metricConditions, m, slices),
        graceRuns: reconcileGraceRuns, dryRun,
      });
      if (releaseNegTgt) {
        removed.push({
          type: "target", id: nt.id,
          keyword_text: asinValue || JSON.stringify(exprArr),
          expression: exprArr,
          campaign_name: nt.campaign_name, action: "remove_negative_reconcile",
          metrics: { clicks: m.clicks, orders: m.orders, spend: m.spend, acos: m.acos },
        });
        if (!dryRun) {
          const newAmazonId = isSyntheticNegId(nt.amazon_neg_target_id)
            ? `archived-${Date.now()}-${nt.id}` : nt.amazon_neg_target_id;
          await query(
            "UPDATE negative_targets SET state='archived', amazon_neg_target_id=$1 WHERE id=$2",
            [newAmazonId, nt.id]
          );
          const reconcileNegTgtAudit = await writeRuleAudit({
            orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
            action: "target.remove_negative_reconcile", entityType: "target",
            entityId: nt.id, entityName: asinValue || JSON.stringify(exprArr),
            beforeData: { state: "enabled" },
            afterData: { state: "archived", reason: "conditions_no_longer_met", metrics: m },
            source: "rule",
          });
          const hasRealId = !isSyntheticNegId(nt.amazon_neg_target_id);
          if (hasRealId && nt.connection_id) {
            trackWriteback(reconcileNegTgtAudit, archiveNegativeTarget({
              connectionId: nt.connection_id, profileId: String(nt.amazon_profile_id),
              marketplaceId: nt.marketplace_id, campaignType: nt.campaign_type,
              amazonNegTargetId: nt.amazon_neg_target_id,
            }), "Reconcile archive neg_tgt failed",
              { entity_id: nt.id, entity_type: "negative_target", keyword_text: null, action: "remove_negative_reconcile" });
          }
        }
      }
    }
  }

  // Wait for reconciliation's own archive write-backs too, so the rule run is fully
  // settled on Amazon's side (not just locally) before this function — and the audit
  // trail's amazon_status — is considered final.
  await Promise.all(pendingWritebacks);

  return {
    matched_count:   matched.length,
    total_evaluated: entities.length,
    entity_counts:   { keywords: keywords.length, targets: targets.length, search_terms: searchTerms.length, ad_groups: adGroupEntities.length, campaigns: campaignEntities.length },
    applied_count:   applied.length,
    skipped_count:   skipped.length,
    removed_count:   removed.length,
    exempted_count:  exemptedCount,
    dry_run:         dryRun,
    period:          { start: startDate, end: endDate, days: periodDays },
    applied,
    skipped,
    removed,
    errors,
    // Amazon rejections are non-fatal (the local DB is updated regardless), so they never
    // reach `errors`. Reporting them separately is what makes a run whose changes Amazon
    // refused show up as "partial" instead of a clean "completed".
    writeback_errors:      writebackErrors,
    writeback_error_count: writebackErrors.length,
  };
}

// ── PATCH /rules/reorder — bulk sort_order update ────────────────────────────
router.patch("/reorder", async (req, res, next) => {
  try {
    const { order } = req.body; // [{ id, sort_order }]
    if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: "order required" });
    await Promise.all(
      order.map(({ id, sort_order }) =>
        query("UPDATE rules SET sort_order = $1 WHERE id = $2 AND workspace_id = $3", [sort_order, id, req.workspaceId])
      )
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /rules/:id/duplicate ─────────────────────────────────────────────────
router.post("/:id/duplicate", async (req, res, next) => {
  try {
    const { rows: [src] } = await query(
      "SELECT * FROM rules WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    if (!src) return res.status(404).json({ error: "Not found" });
    const { rows: [newRule] } = await query(
      `INSERT INTO rules
         (workspace_id, name, description, conditions, actions, schedule, schedule_type, run_hour, scope, safety, dry_run, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        req.workspaceId,
        "Копия: " + src.name,
        src.description || "",
        typeof src.conditions === "string" ? src.conditions : JSON.stringify(src.conditions),
        typeof src.actions    === "string" ? src.actions    : JSON.stringify(src.actions),
        src.schedule, src.schedule_type, src.run_hour ?? 8,
        typeof src.scope  === "string" ? src.scope  : JSON.stringify(src.scope  || {}),
        typeof src.safety === "string" ? src.safety : JSON.stringify(src.safety || {}),
        src.dry_run, req.user.id,
      ]
    );
    res.status(201).json(newRule);
  } catch (err) { next(err); }
});

// ── GET /rules/campaigns — MUST be before /:id to avoid param capture ─────────
router.get("/campaigns", async (req, res, next) => {
  try {
    const q = (req.query.q || "").trim();
    const params = [req.workspaceId];
    let where = "workspace_id = $1 AND state != 'archived'";
    if (q) {
      params.push(`%${q}%`);
      where += ` AND name ILIKE $${params.length}`;
    }
    const { rows } = await query(
      `SELECT id, name, campaign_type, state FROM campaigns
       WHERE ${where} ORDER BY name ASC LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /rules/ad-groups — MUST be before /:id ────────────────────────────────
router.get("/ad-groups", async (req, res, next) => {
  try {
    const { campaignId, profileId: filterProfileId } = req.query;
    const cond   = ["ag.workspace_id = $1"];
    const params = [req.workspaceId];
    let pi = 2;
    if (campaignId)      { cond.push(`ag.campaign_id = $${pi++}`);  params.push(campaignId); }
    if (filterProfileId) { cond.push(`c.profile_id = $${pi++}`);    params.push(filterProfileId); }
    const { rows } = await query(
      `SELECT ag.id, ag.name, ag.campaign_id, c.name AS campaign_name
       FROM ad_groups ag JOIN campaigns c ON c.id = ag.campaign_id
       WHERE ${cond.join(" AND ")} AND ag.state != 'archived'
       ORDER BY c.name, ag.name LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /rules/targets — MUST be before /:id ──────────────────────────────────
router.get("/targets", async (req, res, next) => {
  try {
    const { campaignId } = req.query;
    const cond   = ["t.workspace_id = $1"];
    const params = [req.workspaceId];
    if (campaignId) { cond.push("t.campaign_id = $2"); params.push(campaignId); }
    const { rows } = await query(
      `SELECT t.id, t.expression, t.expression_type, t.state, t.bid,
              t.campaign_id, c.name AS campaign_name
       FROM targets t JOIN campaigns c ON c.id = t.campaign_id
       WHERE ${cond.join(" AND ")} AND t.state != 'archived'
       ORDER BY c.name, t.expression::text LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── Campaign Exemptions — global exclusions from all rules ───────────────────

router.get("/exemptions", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ce.id, ce.campaign_id, ce.expires_at, ce.reason, ce.created_at,
              c.name AS campaign_name
       FROM campaign_exemptions ce
       JOIN campaigns c ON c.id = ce.campaign_id
       WHERE ce.workspace_id = $1
       ORDER BY ce.created_at DESC`,
      [req.workspaceId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/exemptions", async (req, res, next) => {
  try {
    const { campaign_id, expires_at, reason } = req.body;
    if (!campaign_id) return res.status(400).json({ error: "campaign_id required" });
    const { rows: [row] } = await query(
      `INSERT INTO campaign_exemptions (workspace_id, campaign_id, expires_at, reason, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, campaign_id) DO UPDATE SET
         expires_at = EXCLUDED.expires_at,
         reason     = EXCLUDED.reason,
         created_at = NOW()
       RETURNING id`,
      [req.workspaceId, campaign_id, expires_at || null, reason || null, req.user.id]
    );
    const { rows: [full] } = await query(
      `SELECT ce.id, ce.campaign_id, ce.expires_at, ce.reason, ce.created_at,
              c.name AS campaign_name
       FROM campaign_exemptions ce JOIN campaigns c ON c.id = ce.campaign_id
       WHERE ce.id = $1`,
      [row.id]
    );
    res.json(full);
  } catch (err) { next(err); }
});

router.delete("/exemptions/:exemId", async (req, res, next) => {
  try {
    await query(
      "DELETE FROM campaign_exemptions WHERE id = $1 AND workspace_id = $2",
      [req.params.exemId, req.workspaceId]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── GET /rules — list with pagination ────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || 25), 100);
    const page   = Math.max(parseInt(req.query.page   || 1), 1);
    const offset = (page - 1) * limit;

    const [{ rows }, { rows: [cnt] }] = await Promise.all([
      query(
        "SELECT * FROM rules WHERE workspace_id = $1 AND name NOT LIKE '\\_\\_%' ORDER BY COALESCE(sort_order, 99999) ASC, created_at ASC LIMIT $2 OFFSET $3",
        [req.workspaceId, limit, offset]
      ),
      query("SELECT COUNT(*)::int AS count FROM rules WHERE workspace_id = $1 AND name NOT LIKE '\\_\\_%'", [req.workspaceId]),
    ]);

    res.json({
      data: rows,
      pagination: { total: cnt.count, page, limit, pages: Math.ceil(cnt.count / limit) },
    });
  } catch (err) { next(err); }
});

// ── POST /rules — create ──────────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const { name, description, conditions, actions, schedule, schedule_type, run_hour, scope, safety, dry_run } = req.body;
    if (!name || !conditions?.length || !actions?.length) {
      return res.status(400).json({ error: "name, conditions and actions required" });
    }
    const { rows: [rule] } = await query(
      `INSERT INTO rules
         (workspace_id, name, description, conditions, actions, schedule, schedule_type, run_hour, scope, safety, dry_run, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        req.workspaceId, name, description || "",
        JSON.stringify(conditions), JSON.stringify(actions),
        schedule || "0 8 * * *",
        schedule_type || "daily",
        run_hour != null ? parseInt(run_hour) : 8,
        JSON.stringify(scope   || {}),
        JSON.stringify(safety  || { min_bid: 0.02, max_bid: 50 }),
        dry_run || false, req.user.id,
      ]
    );
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

// ── PATCH /rules/:id — update ─────────────────────────────────────────────────
router.patch("/:id", async (req, res, next) => {
  try {
    const { name, description, conditions, actions, schedule, schedule_type, run_hour, scope, safety, dry_run, is_active } = req.body;
    // If conditions/actions are explicitly provided, refuse to write empty
    // arrays — those would let executeRule treat every entity as matched.
    if (conditions !== undefined && (!Array.isArray(conditions) || conditions.length === 0)) {
      return res.status(400).json({ error: "conditions cannot be empty when provided" });
    }
    if (actions !== undefined && (!Array.isArray(actions) || actions.length === 0)) {
      return res.status(400).json({ error: "actions cannot be empty when provided" });
    }
    const { rows: [rule] } = await query(
      `UPDATE rules SET
         name          = COALESCE($1, name),
         description   = COALESCE($2, description),
         conditions    = COALESCE($3::jsonb, conditions),
         actions       = COALESCE($4::jsonb, actions),
         schedule      = COALESCE($5, schedule),
         schedule_type = COALESCE($6, schedule_type),
         run_hour      = COALESCE($7, run_hour),
         scope         = COALESCE($8::jsonb, scope),
         safety        = COALESCE($9::jsonb, safety),
         dry_run       = COALESCE($10, dry_run),
         is_active     = COALESCE($11, is_active),
         next_run_at   = CASE
           WHEN ($6 IS NOT NULL AND $6 IS DISTINCT FROM schedule_type)
             OR ($7 IS NOT NULL AND $7::int IS DISTINCT FROM run_hour)
           THEN NULL ELSE next_run_at END,
         updated_at    = NOW()
       WHERE id = $12 AND workspace_id = $13
       RETURNING *`,
      [
        name, description,
        conditions ? JSON.stringify(conditions) : null,
        actions    ? JSON.stringify(actions)    : null,
        schedule, schedule_type,
        run_hour != null ? parseInt(run_hour) : null,
        scope   ? JSON.stringify(scope)   : null,
        safety  ? JSON.stringify(safety)  : null,
        dry_run, is_active,
        req.params.id, req.workspaceId,
      ]
    );
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    res.json(rule);
  } catch (err) { next(err); }
});

// ── DELETE /rules/:id — moves to trash (30-day soft delete) ──────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    const { rows: [rule] } = await query(
      "SELECT * FROM rules WHERE id=$1 AND workspace_id=$2",
      [req.params.id, req.workspaceId]
    );
    if (!rule) return res.status(404).json({ error: "Rule not found" });

    await query(
      `INSERT INTO trash (workspace_id, entity_type, entity_id, entity_name, data, deleted_by)
       VALUES ($1, 'rule', $2, $3, $4::jsonb, $5)`,
      [req.workspaceId, rule.id, rule.name, JSON.stringify(rule), req.user?.id ?? null]
    );
    await query("DELETE FROM rules WHERE id=$1 AND workspace_id=$2", [req.params.id, req.workspaceId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /rules/preview — dry-run with form body, never persists ──────────────
// Used by the rule editor: lets users preview an UNSAVED rule (or unsaved edits
// to an existing rule) against fresh metrics. Does not write to rules,
// rule_executions, or audit_log — pure read-only evaluation.
router.post("/preview", async (req, res, next) => {
  try {
    const body = req.body || {};
    // Empty arrays are truthy — must explicitly check `.length`. Without this
    // a `{conditions: [], actions: [...]}` body would pass and the engine
    // would treat every entity as matching (Array.every on []=true).
    if (!Array.isArray(body.conditions) || body.conditions.length === 0) {
      return res.status(400).json({ error: "At least one condition is required" });
    }
    if (!Array.isArray(body.actions) || body.actions.length === 0) {
      return res.status(400).json({ error: "At least one action is required" });
    }
    const synthetic = {
      id: null,
      workspace_id: req.workspaceId,
      name: body.name || "__preview__",
      conditions: body.conditions,
      actions: body.actions,
      scope: body.scope || {},
      safety: body.safety || {},
      dry_run: true,
      is_active: false,
    };
    const result = await executeRule(synthetic, req.workspaceId, true, req.user.id, req.user.name);
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /rules/:id/run — execute synchronously ───────────────────────────────
router.post("/:id/run", async (req, res, next) => {
  try {
    const { dry_run } = req.body;
    const { rows: [rule] } = await query(
      "SELECT * FROM rules WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    if (!rule) return res.status(404).json({ error: "Rule not found" });

    const effectiveDryRun = dry_run !== undefined ? dry_run : rule.dry_run;

    // For real (non-dry) runs: check the workspace lock so manual runs
    // can't race with the cron worker executing the same workspace's rules.
    let ownedLock = false;
    const workspaceLockKey = `rule_exec_lock:${req.workspaceId}`;
    const manualLockKey    = `rule_exec_lock:manual:${req.params.id}`;
    if (!effectiveDryRun) {
      const redis = getRedis();
      // Reject if the automated worker already holds the workspace lock.
      const existing = await redis.get(workspaceLockKey);
      if (existing) {
        return res.status(409).json({
          error: "rule_locked",
          message: "Another rule execution is already in progress for this workspace. Please try again in a moment.",
        });
      }
      // Acquire per-rule lock to prevent duplicate manual clicks.
      const acquired = await redis.set(manualLockKey, req.user.id, "NX", "EX", 120);
      if (!acquired) {
        return res.status(409).json({
          error: "rule_locked",
          message: "This rule is already running. Please wait for it to finish.",
        });
      }
      ownedLock = true;
    }

    let result;
    const startedAt = new Date();
    try {
      result = await executeRule(rule, req.workspaceId, effectiveDryRun, req.user.id, req.user.name);
    } finally {
      if (ownedLock) {
        const redis = getRedis();
        const current = await redis.get(manualLockKey);
        if (current === req.user.id) await redis.del(manualLockKey);
      }
    }

    const nextRunAt = effectiveDryRun ? null : computeNextRun(rule.schedule_type, rule.run_hour);
    await query(
      effectiveDryRun
        ? "UPDATE rules SET last_run_result = $1 WHERE id = $2"
        : `UPDATE rules SET last_run_at = NOW(), last_run_result = $1, next_run_at = $3,
             last_run_status = $4, run_count = COALESCE(run_count, 0) + 1 WHERE id = $2`,
      effectiveDryRun
        ? [JSON.stringify(result), req.params.id]
        : [JSON.stringify(result), req.params.id, nextRunAt, runStatusFromResult(result)]
    );
    if (!effectiveDryRun) await insertRuleExecution(req.params.id, req.workspaceId, result, false, startedAt);

    logger.info("Rule executed", { ruleId: rule.id, ruleName: rule.name, ...result });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /rules/:id/runs — execution history
router.get("/:id/runs", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, started_at, completed_at, dry_run, status,
              entities_evaluated, entities_matched, actions_taken, actions_failed,
              entities_skipped, summary, diagnostics, error_message
       FROM rule_executions
       WHERE rule_id = $1 AND workspace_id = $2
       ORDER BY started_at DESC LIMIT 50`,
      [req.params.id, req.workspaceId]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── Schedule helpers ──────────────────────────────────────────────────────────
const FREQ_DAYS = { daily: 1, every_2_days: 2, every_3_days: 3, weekly: 7, monthly: 30 };

function computeNextRun(scheduleType, runHour) {
  const days = FREQ_DAYS[scheduleType] ?? 1;
  const hour = (runHour != null && runHour >= 0 && runHour <= 23) ? parseInt(runHour) : 8;
  const next = new Date();
  next.setUTCDate(next.getUTCDate() + days);
  next.setUTCHours(hour, 0, 0, 0);
  return next;
}

// Derive a run-level status from the executeRule result summary.
// "partial" when any action errored locally OR Amazon rejected a write-back, otherwise "completed".
function runStatusFromResult(result) {
  const failed = (result?.errors?.length || 0) + (result?.writeback_error_count || 0);
  return failed ? "partial" : "completed";
}

// Why a run did what it did, condensed for storage.
//
// A run that matched 30 entities and changed none is normal — every match can be legitimately
// skipped (already paused, budget not binding, already negative). Persisting only the applied
// list made that indistinguishable from a broken rule, and the reasons the engine had already
// computed were thrown away when executeRule returned. `by_reason` gives the shape of the run
// at a glance; `samples` keeps a few entity names per reason so it can be acted on, capped so
// a 20 000-entity run cannot bloat the row.
const DIAGNOSTIC_SAMPLES_PER_REASON = 5;

function summarizeRunDiagnostics(result) {
  const byReason = {};
  const samples  = {};
  for (const s of (result?.skipped || [])) {
    const reason = s?.reason || "unknown";
    byReason[reason] = (byReason[reason] || 0) + 1;
    if (!samples[reason]) samples[reason] = [];
    if (samples[reason].length < DIAGNOSTIC_SAMPLES_PER_REASON) {
      samples[reason].push({
        entity_type:  s?.entity_type || null,
        keyword_text: s?.keyword_text || s?.campaign_name || null,
        action:       s?.action || null,
        ...(s?.detail?.amazon_error ? { amazon_error: String(s.detail.amazon_error).slice(0, 300) } : {}),
      });
    }
  }
  return {
    skipped_by_reason: byReason,
    skipped_samples:   samples,
    // Amazon rejections never reach `errors` (the local DB is updated regardless), so without
    // this the only record of them was the audit row.
    writeback_errors: (result?.writeback_errors || []).slice(0, 25),
    errors:           (result?.errors || []).slice(0, 25),
  };
}

// Persist a row into rule_executions so /rules/:id/runs has real history.
// Best-effort: a failed insert must never break rule execution.
//
// `startedAt` must be captured before executeRule runs. The row is only written once, at the
// end, so letting started_at default to NOW() made it equal completed_at — every run showed a
// zero duration, which hid how long a rule actually took (some evaluate 68k entities).
async function insertRuleExecution(ruleId, workspaceId, result, dryRun, startedAt = null) {
  try {
    await query(
      `INSERT INTO rule_executions
         (rule_id, workspace_id, started_at, completed_at, dry_run, status,
          entities_evaluated, entities_matched, actions_taken, actions_failed,
          entities_skipped, summary, diagnostics)
       VALUES ($1,$2,COALESCE($3, NOW()),NOW(),$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        ruleId, workspaceId, startedAt, !!dryRun, runStatusFromResult(result),
        result?.total_evaluated || 0,
        result?.matched_count || 0,
        (result?.applied_count || 0) + (result?.removed_count || 0),
        (result?.errors?.length || 0) + (result?.writeback_error_count || 0),
        result?.skipped_count || 0,
        JSON.stringify(result?.applied || []),
        JSON.stringify(summarizeRunDiagnostics(result)),
      ]
    );
  } catch (e) {
    logger.warn("Failed to insert rule_execution", { ruleId, error: e.message });
  }
}

// Called by the RULE_EXECUTION worker — runs all keyword/target rules
// that are due for this workspace and advances next_run_at.
async function executeAllDueRules(workspaceId) {
  const { rows: rules } = await query(
    `SELECT * FROM rules
     WHERE workspace_id = $1 AND is_active = TRUE
       AND name NOT LIKE '\\_\\_%'
       AND (next_run_at IS NULL OR next_run_at <= NOW())
     ORDER BY COALESCE(sort_order, 99999) ASC, created_at ASC`,
    [workspaceId]
  );
  const results = [];
  for (const rule of rules) {
    try {
      const startedAt = new Date();
      const result = await executeRule(rule, workspaceId, rule.dry_run, null, "Rule Engine");
      const nextRunAt = computeNextRun(rule.schedule_type, rule.run_hour);
      await query(
        rule.dry_run
          ? "UPDATE rules SET last_run_result = $1, next_run_at = $2 WHERE id = $3"
          : `UPDATE rules SET last_run_at = NOW(), last_run_result = $1, next_run_at = $2,
               last_run_status = $4, run_count = COALESCE(run_count, 0) + 1 WHERE id = $3`,
        rule.dry_run
          ? [JSON.stringify(result), nextRunAt, rule.id]
          : [JSON.stringify(result), nextRunAt, rule.id, runStatusFromResult(result)]
      );
      await insertRuleExecution(rule.id, workspaceId, result, rule.dry_run, startedAt);
      results.push({ ruleId: rule.id, ruleName: rule.name, ...result });
    } catch (e) {
      logger.error("executeAllDueRules: rule failed", { ruleId: rule.id, error: e.message });
    }
  }
  return { workspaceId, rules_executed: results.length, results };
}

module.exports = router;
module.exports.executeAllDueRules = executeAllDueRules;
// Exposed for dry-run verification against a live database without going through auth.
module.exports.executeRule = executeRule;
// Internals exposed for unit tests only — not part of the route contract.
module.exports.__test = { runStatusFromResult, withDerivedMetrics, isSyntheticNegId, negativeStillJustified,
  isPermanentWritebackError, summarizeRunDiagnostics };
