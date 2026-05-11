"use strict";
/**
 * Seed helpers for integration tests.
 * All functions accept a pg Pool/Client and return early if data already exists.
 */

const { IDS, AZ_IDS } = require("../setup/testConfig");

// ── Base data (seeded once in beforeAll) ────────────────────────────────────
async function seedBase(pool) {
  // Organizations
  await pool.query(`
    INSERT INTO organizations (id, name, slug, plan)
    VALUES ($1, 'Integration Test Org', 'integration-test', 'pro')
    ON CONFLICT (id) DO NOTHING
  `, [IDS.org]);

  // Users
  await pool.query(`
    INSERT INTO users (id, org_id, email, password_hash, name, role)
    VALUES ($1, $2, 'inttest@test.com', '$2a$10$fake', 'Integration Tester', 'owner')
    ON CONFLICT (id) DO NOTHING
  `, [IDS.user, IDS.org]);

  // Workspaces
  await pool.query(`
    INSERT INTO workspaces (id, org_id, name, created_by)
    VALUES ($1, $2, 'Test Workspace', $3)
    ON CONFLICT (id) DO NOTHING
  `, [IDS.workspace, IDS.org, IDS.user]);

  // Workspace members
  await pool.query(`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES ($1, $2, 'owner')
    ON CONFLICT DO NOTHING
  `, [IDS.workspace, IDS.user]);

  // Amazon connection (tokens are fake — Amazon API calls are mocked in tests)
  await pool.query(`
    INSERT INTO amazon_connections
      (id, org_id, workspace_id, amazon_account_id, amazon_email,
       access_token_enc, refresh_token_enc, token_expires_at, status)
    VALUES ($1, $2, $3, 'TEST-ACCOUNT-001', 'test@amazon.com',
       'FAKE_ENC_ACCESS', 'FAKE_ENC_REFRESH', NOW() + INTERVAL '1 year', 'active')
    ON CONFLICT (id) DO NOTHING
  `, [IDS.connection, IDS.org, IDS.workspace]);

  // Amazon profile
  await pool.query(`
    INSERT INTO amazon_profiles
      (id, connection_id, workspace_id, profile_id, marketplace_id,
       marketplace, country_code, currency_code, timezone,
       account_name, account_type, is_attached)
    VALUES ($1, $2, $3, 111222333, 'A1PA6795UKMFR9',
       'DE', 'DE', 'EUR', 'Europe/Berlin',
       'Test Seller Account', 'seller', true)
    ON CONFLICT (id) DO NOTHING
  `, [IDS.profile, IDS.connection, IDS.workspace]);

  // ── Campaigns ──────────────────────────────────────────────────────────────
  // Manual targeting campaign
  await pool.query(`
    INSERT INTO campaigns
      (id, workspace_id, profile_id, amazon_campaign_id,
       name, campaign_type, targeting_type, state, daily_budget)
    VALUES ($1, $2, $3, 'AZ-CAMP-MANUAL-001',
       'Alpha Manual Campaign', 'sponsoredProducts', 'MANUAL', 'enabled', 50.00)
    ON CONFLICT (id) DO NOTHING
  `, [IDS.campManual, IDS.workspace, IDS.profile]);

  // Auto targeting campaign
  await pool.query(`
    INSERT INTO campaigns
      (id, workspace_id, profile_id, amazon_campaign_id,
       name, campaign_type, targeting_type, state, daily_budget)
    VALUES ($1, $2, $3, 'AZ-CAMP-AUTO-001',
       'Beta Auto Campaign', 'sponsoredProducts', 'AUTO', 'enabled', 30.00)
    ON CONFLICT (id) DO NOTHING
  `, [IDS.campAuto, IDS.workspace, IDS.profile]);

  // ── Ad Groups ──────────────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO ad_groups
      (id, workspace_id, profile_id, campaign_id,
       amazon_ag_id, name, state, default_bid)
    VALUES ($1, $2, $3, $4, 'AZ-AG-MANUAL-001', 'Manual Ad Group 1', 'enabled', 0.80)
    ON CONFLICT (id) DO NOTHING
  `, [IDS.agManual, IDS.workspace, IDS.profile, IDS.campManual]);

  await pool.query(`
    INSERT INTO ad_groups
      (id, workspace_id, profile_id, campaign_id,
       amazon_ag_id, name, state, default_bid)
    VALUES ($1, $2, $3, $4, 'AZ-AG-AUTO-001', 'Auto Ad Group 1', 'enabled', 0.50)
    ON CONFLICT (id) DO NOTHING
  `, [IDS.agAuto, IDS.workspace, IDS.profile, IDS.campAuto]);

  // ── Keywords ───────────────────────────────────────────────────────────────
  const kws = [
    [IDS.kwExact1,  AZ_IDS.kwExact1,  IDS.campManual, IDS.agManual, "running shoes",    "exact",  "enabled", 1.00],
    [IDS.kwPhrase1, AZ_IDS.kwPhrase1, IDS.campManual, IDS.agManual, "red running shoes", "phrase", "enabled", 0.80],
    [IDS.kwBroad1,  AZ_IDS.kwBroad1,  IDS.campManual, IDS.agManual, "sport shoes",       "broad",  "enabled", 0.50],
    [IDS.kwPaused1, AZ_IDS.kwPaused1, IDS.campManual, IDS.agManual, "paused keyword",    "exact",  "paused",  1.00],
    [IDS.kwAuto1,   AZ_IDS.kwAuto1,   IDS.campAuto,   IDS.agAuto,   "auto keyword",      "exact",  "enabled", 0.60],
  ];
  for (const [id, azId, campId, agId, text, matchType, state, bid] of kws) {
    await pool.query(`
      INSERT INTO keywords
        (id, workspace_id, profile_id, ad_group_id, campaign_id,
         amazon_keyword_id, keyword_text, match_type, state, bid)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO NOTHING
    `, [id, IDS.workspace, IDS.profile, agId, campId, azId, text, matchType, state, bid]);
  }

  // ── Target ─────────────────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO targets
      (id, workspace_id, profile_id, campaign_id, ad_group_id,
       amazon_target_id, ad_type, expression_type, expression, state, bid)
    VALUES ($1, $2, $3, $4, $5, $6, 'SP', 'asinSameAs',
       $7::jsonb, 'enabled', 0.80)
    ON CONFLICT (id) DO NOTHING
  `, [
    IDS.tgt1, IDS.workspace, IDS.profile, IDS.campManual, IDS.agManual,
    AZ_IDS.tgt1,
    JSON.stringify([{ type: "asinSameAs", value: "B0TESTPROD1" }]),
  ]);
}

// ── Seed daily metrics for a set of keywords ────────────────────────────────
// opts: { cost, sales14d, clicks, impressions, orders14d, date }
// acos = cost/sales14d*100, so for acos=66%: cost=10, sales14d=15
async function seedKeywordMetrics(pool, keywordEntries, opts = {}) {
  const {
    cost = 10.00, sales14d = 15.00, clicks = 100,
    impressions = 5000, orders14d = 0,
    date = yesterday(),
  } = opts;

  for (const { kwId, azId } of keywordEntries) {
    await pool.query(`
      INSERT INTO fact_metrics_daily
        (workspace_id, profile_id, date, entity_type, entity_id, amazon_id,
         campaign_type, impressions, clicks, cost, sales_14d, orders_14d)
      VALUES ($1, $2, $3, 'keyword', $4, $5, 'sponsoredProducts',
              $6, $7, $8, $9, $10)
      ON CONFLICT (profile_id, amazon_id, entity_type, date) DO UPDATE
        SET cost=$8, sales_14d=$9, clicks=$7, impressions=$6, orders_14d=$10
    `, [IDS.workspace, IDS.profile, date, kwId, azId,
        impressions, clicks, cost, sales14d, orders14d]);
  }
}

// ── Seed target metrics ──────────────────────────────────────────────────────
async function seedTargetMetrics(pool, opts = {}) {
  const {
    cost = 10.00, sales14d = 15.00, clicks = 50,
    impressions = 2000, orders14d = 0,
    date = yesterday(),
  } = opts;

  await pool.query(`
    INSERT INTO fact_metrics_daily
      (workspace_id, profile_id, date, entity_type, entity_id, amazon_id,
       campaign_type, impressions, clicks, cost, sales_14d, orders_14d)
    VALUES ($1, $2, $3, 'target', $4, $5, 'sponsoredProducts',
            $6, $7, $8, $9, $10)
    ON CONFLICT (profile_id, amazon_id, entity_type, date) DO UPDATE
      SET cost=$8, sales_14d=$9, clicks=$7, impressions=$6, orders_14d=$10
  `, [IDS.workspace, IDS.profile, date, IDS.tgt1, AZ_IDS.tgt1,
      impressions, clicks, cost, sales14d, orders14d]);
}

// ── Seed search_term_metrics ─────────────────────────────────────────────────
async function seedSearchTermMetrics(pool, entries) {
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
  for (const { query, kwId = null, matchType = "exact", clicks = 100, spend = 10, orders = 0, sales = 0 } of entries) {
    await pool.query(`
      INSERT INTO search_term_metrics
        (workspace_id, profile_id, campaign_id, ad_group_id,
         query, keyword_id, match_type, impressions, clicks, spend, orders, sales,
         date_start, date_end)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 5000, $8, $9, $10, $11, $12, $12)
      ON CONFLICT DO NOTHING
    `, [IDS.workspace, IDS.profile, IDS.campManual, IDS.agManual,
        query, kwId, matchType, clicks, spend, orders, sales, yesterday]);
  }
}

// ── Clean mutable state between tests ────────────────────────────────────────
// Fixed seeded IDs that must NOT be deleted between tests
const SEEDED_CAMPAIGN_IDS = [IDS.campManual, IDS.campAuto];
const SEEDED_AG_IDS       = [IDS.agManual, IDS.agAuto];
const SEEDED_KW_IDS       = [IDS.kwExact1, IDS.kwPhrase1, IDS.kwBroad1, IDS.kwPaused1, IDS.kwAuto1];

async function cleanMutable(pool) {
  // Delete in FK-safe order (audit_events is immutable by design — trigger disabled in globalSetup)
  await pool.query("DELETE FROM negative_keywords  WHERE workspace_id = $1", [IDS.workspace]);
  await pool.query("DELETE FROM negative_targets   WHERE workspace_id = $1", [IDS.workspace]);
  await pool.query("DELETE FROM rules              WHERE workspace_id = $1", [IDS.workspace]);
  await pool.query("DELETE FROM audit_events       WHERE workspace_id = $1", [IDS.workspace]);
  await pool.query("DELETE FROM search_term_metrics WHERE workspace_id = $1", [IDS.workspace]);
  await pool.query("DELETE FROM fact_metrics_daily  WHERE workspace_id = $1", [IDS.workspace]);

  // Delete dynamically created keywords, ad_groups, campaigns (test-created, not seeded)
  await pool.query(
    `DELETE FROM keywords  WHERE workspace_id = $1 AND id != ALL($2::uuid[])`,
    [IDS.workspace, SEEDED_KW_IDS]
  );
  await pool.query(
    `DELETE FROM ad_groups WHERE workspace_id = $1 AND id != ALL($2::uuid[])`,
    [IDS.workspace, SEEDED_AG_IDS]
  );
  await pool.query(
    `DELETE FROM campaigns WHERE workspace_id = $1 AND id != ALL($2::uuid[])`,
    [IDS.workspace, SEEDED_CAMPAIGN_IDS]
  );

  // Reset seeded campaign budgets and states
  await pool.query(`UPDATE campaigns SET state = 'enabled', daily_budget = 50.00 WHERE id = $1`, [IDS.campManual]);
  await pool.query(`UPDATE campaigns SET state = 'enabled', daily_budget = 30.00 WHERE id = $1`, [IDS.campAuto]);

  // Reset seeded ad group bids and state
  await pool.query(`UPDATE ad_groups SET state = 'enabled', default_bid = 0.80 WHERE id = $1`, [IDS.agManual]);
  await pool.query(`UPDATE ad_groups SET state = 'enabled', default_bid = 0.50 WHERE id = $1`, [IDS.agAuto]);

  // Reset keyword state and bids to defaults
  await pool.query(`
    UPDATE keywords SET state = 'enabled', bid = 1.00 WHERE id = $1
  `, [IDS.kwExact1]);
  await pool.query(`
    UPDATE keywords SET state = 'enabled', bid = 0.80 WHERE id = $1
  `, [IDS.kwPhrase1]);
  await pool.query(`
    UPDATE keywords SET state = 'enabled', bid = 0.50 WHERE id = $1
  `, [IDS.kwBroad1]);
  await pool.query(`
    UPDATE keywords SET state = 'paused',  bid = 1.00 WHERE id = $1
  `, [IDS.kwPaused1]);
  await pool.query(`
    UPDATE keywords SET state = 'enabled', bid = 0.60 WHERE id = $1
  `, [IDS.kwAuto1]);
  // Reset target
  await pool.query(`
    UPDATE targets SET state = 'enabled', bid = 0.80 WHERE id = $1
  `, [IDS.tgt1]);
}

function yesterday() {
  return new Date(Date.now() - 86400000).toISOString().split("T")[0];
}

module.exports = { seedBase, seedKeywordMetrics, seedTargetMetrics, seedSearchTermMetrics, cleanMutable, yesterday };
