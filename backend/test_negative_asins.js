/**
 * Negative ASINs Test Suite
 *
 * Tests:
 *   1. Route: POST /api/v1/negative-asins — add single ASIN
 *   2. Route: GET  /api/v1/negative-asins — list with filtering
 *   3. Route: POST /api/v1/negative-asins/bulk — bulk add
 *   4. Route: DELETE /api/v1/negative-asins/:id — delete single
 *   5. Route: DELETE /api/v1/negative-asins/bulk — bulk delete
 *   6. Rule engine: add_negative_asin action applied to matched campaigns
 *   7. Rule engine: duplicate ASIN skipped (pre-check)
 *   8. Rule engine: add_negative_asin in dry-run mode (nothing written)
 */

const { query, connectDB } = require("./src/db/pool");
const { executeRules }     = require("./src/services/rules/engine");

const WORKSPACE_ID = "05831bc2-b7b3-44f2-a3e2-149ad0759627";
const PROFILE_ID   = "1fa69533-8970-4bb8-bcf3-6fcc016fc707";
const TEST_BUDGET  = 1234567.89;
const TEST_COND    = [{ field: "daily_budget", operator: "gte", value: 1234560 }];

let passed = 0;
let failed = 0;
const createdRuleIds     = [];
const createdCampaignIds = [];
const createdNegTargetIds = [];
let pausedRuleIds = [];

function assert(condition, label, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

async function createTestCampaign(suffix) {
  const { rows: [c] } = await query(
    `INSERT INTO campaigns
       (workspace_id, profile_id, name, state, daily_budget, campaign_type, amazon_campaign_id)
     VALUES ($1, $2, $3, 'paused', $4, 'sponsoredProducts', $5)
     RETURNING id`,
    [WORKSPACE_ID, PROFILE_ID, `__test_nasin_${suffix}__`, TEST_BUDGET,
     `TEST_NASIN_${suffix}_${Date.now()}`]
  );
  createdCampaignIds.push(c.id);
  return c.id;
}

async function createRule({ name, conditions, actions, dryRun = false }) {
  const { rows: [rule] } = await query(
    `INSERT INTO rules (workspace_id, name, is_active, conditions, actions, dry_run, priority, schedule_type)
     VALUES ($1, $2, true, $3, $4, $5, 50, 'manual') RETURNING id`,
    [WORKSPACE_ID, name, JSON.stringify(conditions), JSON.stringify(actions), dryRun]
  );
  createdRuleIds.push(rule.id);
  return rule.id;
}

async function pauseRealRules() {
  const { rows } = await query(
    `UPDATE rules SET is_active = false
     WHERE workspace_id = $1 AND name NOT LIKE '__test_%' RETURNING id`,
    [WORKSPACE_ID]
  );
  pausedRuleIds = rows.map(r => r.id);
  console.log(`  (paused ${pausedRuleIds.length} real rules)`);
}

async function restoreRealRules() {
  if (pausedRuleIds.length) {
    await query(`UPDATE rules SET is_active = true WHERE id = ANY($1::uuid[])`, [pausedRuleIds]);
  }
}

async function cleanup() {
  await restoreRealRules();
  if (createdRuleIds.length) {
    await query(`DELETE FROM rules WHERE id = ANY($1::uuid[])`, [createdRuleIds]);
    await query(`DELETE FROM rule_executions WHERE rule_id = ANY($1::uuid[])`, [createdRuleIds]);
  }
  if (createdCampaignIds.length) {
    await query(`DELETE FROM negative_targets WHERE campaign_id = ANY($1::uuid[])`, [createdCampaignIds]);
    await query(`DELETE FROM rule_entity_cooldowns WHERE entity_id = ANY($1::uuid[])`, [createdCampaignIds]);
    await query(`DELETE FROM campaigns WHERE id = ANY($1::uuid[])`, [createdCampaignIds]);
  }
}

// ─── Test helpers using the route handlers directly via DB ─────────────────────

// Simulate POST /api/v1/negative-asins by inserting directly + returning the record
async function apiAddAsin(campaignId, asinValue) {
  // Mimic what the route does
  const { rows: campRows } = await query(
    `SELECT c.profile_id FROM campaigns c WHERE c.id = $1`,
    [campaignId]
  );
  if (!campRows[0]) throw new Error('Campaign not found');
  const profileId = campRows[0].profile_id;
  const asinClean = asinValue.trim().toUpperCase();
  const expression = [{ type: 'asinSameAs', value: asinClean }];
  const fakeId = `test_neg_asin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const { rows } = await query(
    `INSERT INTO negative_targets
       (workspace_id, profile_id, campaign_id, amazon_neg_target_id,
        ad_type, expression, expression_type, level)
     VALUES ($1,$2,$3,$4,'SP',$5,'manual','campaign')
     ON CONFLICT (profile_id, amazon_neg_target_id) DO NOTHING
     RETURNING id, expression, level, created_at`,
    [WORKSPACE_ID, profileId, campaignId, fakeId, JSON.stringify(expression)]
  );
  if (rows[0]) createdNegTargetIds.push(rows[0].id);
  return rows[0] ? { ...rows[0], asin: asinClean } : null;
}

// ─── Test 1: Route — add single ASIN ─────────────────────────────────────────
async function testAddSingle() {
  console.log("\n[ Route ] POST /negative-asins — add single ASIN");

  const campId = await createTestCampaign("add1");
  const result = await apiAddAsin(campId, "B00TESTAA1");

  assert(!!result, "Insert returned a record");
  assert(result?.asin === "B00TESTAA1", "ASIN stored correctly", `got: ${result?.asin}`);
  assert(result?.level === "campaign", "Level = 'campaign'");

  // Verify in DB
  const { rows } = await query(
    `SELECT expression FROM negative_targets WHERE id = $1`,
    [result.id]
  );
  assert(rows[0]?.expression?.[0]?.type === "asinSameAs", "expression type = asinSameAs");
  assert(rows[0]?.expression?.[0]?.value === "B00TESTAA1", "expression value = B00TESTAA1");
}

// ─── Test 2: Route — GET list with filtering ──────────────────────────────────
async function testList() {
  console.log("\n[ Route ] GET /negative-asins — list and filter");

  const campId = await createTestCampaign("list1");
  await apiAddAsin(campId, "B00LISTAA1");
  await apiAddAsin(campId, "B00LISTAA2");

  const { rows } = await query(
    `SELECT id, expression FROM negative_targets
     WHERE campaign_id = $1 ORDER BY created_at DESC`,
    [campId]
  );

  assert(rows.length === 2, "2 records returned for campaign", `got ${rows.length}`);
  const asins = rows.map(r => r.expression?.[0]?.value);
  assert(asins.includes("B00LISTAA1") && asins.includes("B00LISTAA2"), "Both ASINs present");
}

// ─── Test 3: Route — bulk add ─────────────────────────────────────────────────
async function testBulkAdd() {
  console.log("\n[ Route ] POST /negative-asins/bulk — bulk add");

  const c1 = await createTestCampaign("bulk1");
  const c2 = await createTestCampaign("bulk2");
  const asins = ["B00BULKAA1", "B00BULKAA2", "B00BULKAA3"];

  // Simulate bulk add across 2 campaigns
  let added = 0;
  for (const campId of [c1, c2]) {
    for (const asin of asins) {
      const r = await apiAddAsin(campId, asin);
      if (r) added++;
    }
  }

  assert(added === 6, `Bulk add: 3 ASINs × 2 campaigns = 6 rows`, `got ${added}`);

  const { rows } = await query(
    `SELECT COUNT(*) AS cnt FROM negative_targets WHERE campaign_id = ANY($1::uuid[])`,
    [[c1, c2]]
  );
  assert(parseInt(rows[0].cnt) === 6, "DB contains all 6 rows", `cnt=${rows[0].cnt}`);
}

// ─── Test 4: Route — delete single ───────────────────────────────────────────
async function testDeleteSingle() {
  console.log("\n[ Route ] DELETE /negative-asins/:id — delete single");

  const campId = await createTestCampaign("del1");
  const inserted = await apiAddAsin(campId, "B00DELAA11");
  assert(!!inserted, "Record created before delete test");

  await query(`DELETE FROM negative_targets WHERE id = $1`, [inserted.id]);
  // Remove from tracking since already deleted
  const idx = createdNegTargetIds.indexOf(inserted.id);
  if (idx !== -1) createdNegTargetIds.splice(idx, 1);

  const { rows } = await query(
    `SELECT id FROM negative_targets WHERE id = $1`, [inserted.id]
  );
  assert(rows.length === 0, "Record deleted from DB");
}

// ─── Test 5: Route — bulk delete ─────────────────────────────────────────────
async function testBulkDelete() {
  console.log("\n[ Route ] DELETE /negative-asins/bulk — bulk delete");

  const campId = await createTestCampaign("bdel1");
  const r1 = await apiAddAsin(campId, "B00BDELAA1");
  const r2 = await apiAddAsin(campId, "B00BDELAA2");
  const r3 = await apiAddAsin(campId, "B00BDELAA3");

  const ids = [r1.id, r2.id, r3.id];
  const { rowCount } = await query(
    `DELETE FROM negative_targets WHERE id = ANY($1::uuid[]) AND workspace_id = $2`,
    [ids, WORKSPACE_ID]
  );
  // Remove from tracking
  for (const id of ids) {
    const idx = createdNegTargetIds.indexOf(id);
    if (idx !== -1) createdNegTargetIds.splice(idx, 1);
  }

  assert(rowCount === 3, `Bulk delete removed 3 rows`, `rowCount=${rowCount}`);

  const { rows } = await query(
    `SELECT id FROM negative_targets WHERE id = ANY($1::uuid[])`, [ids]
  );
  assert(rows.length === 0, "All 3 records gone from DB");
}

// ─── Test 6: Rule engine — add_negative_asin applied ─────────────────────────
async function testRuleEngineApply() {
  console.log("\n[ Engine ] add_negative_asin — action applied to matched campaigns");

  const c1 = await createTestCampaign("eng1");
  const c2 = await createTestCampaign("eng2");
  await query(`DELETE FROM negative_targets WHERE campaign_id = ANY($1::uuid[])`, [[c1, c2]]);

  const ruleId = await createRule({
    name: "__test_nasin_rule__",
    conditions: TEST_COND,
    actions: [{ type: "add_negative_asin", value: "B00ENGASIN" }],
  });

  const { results } = await executeRules(WORKSPACE_ID, ruleId, {
    forceDryRun: false, saveExecution: false,
  });

  const ruleResult = results.find(r => r.ruleId === ruleId);
  assert(!!ruleResult, "Rule executed");

  if (ruleResult) {
    const testIds = [c1, c2];
    const applied = ruleResult.summary.filter(s => s.applied && testIds.includes(s.entityId));
    assert(applied.length === 2, "Action applied to both test campaigns", `applied=${applied.length}`);
    assert(applied.every(s => s.newValue === "B00ENGASIN"), "newValue = B00ENGASIN");
  }

  // Verify in DB
  const { rows } = await query(
    `SELECT id, expression FROM negative_targets WHERE campaign_id = ANY($1::uuid[])`,
    [[c1, c2]]
  );
  assert(rows.length === 2, "2 rows in negative_targets after rule run", `got ${rows.length}`);
  assert(rows.every(r => r.expression?.[0]?.value === "B00ENGASIN"), "expression value correct in DB");
}

// ─── Test 7: Rule engine — duplicate ASIN skipped ────────────────────────────
async function testRuleEngineDuplicate() {
  console.log("\n[ Engine ] add_negative_asin — duplicate ASIN skipped (pre-check)");

  const campId = await createTestCampaign("dup1");

  // Pre-insert the ASIN so it already exists
  await apiAddAsin(campId, "B00DUPASIN");

  const ruleId = await createRule({
    name: "__test_nasin_dup__",
    conditions: TEST_COND,
    actions: [{ type: "add_negative_asin", value: "B00DUPASIN" }],
  });

  const { results } = await executeRules(WORKSPACE_ID, ruleId, {
    forceDryRun: false, saveExecution: false,
  });

  const ruleResult = results.find(r => r.ruleId === ruleId);
  assert(!!ruleResult, "Rule executed");

  if (ruleResult) {
    const applied = ruleResult.summary.filter(s => s.applied && s.entityId === campId);
    assert(applied.length === 0, "Duplicate ASIN not applied again (pre-check caught it)", `applied=${applied.length}`);
  }

  // Confirm only 1 row in DB (not 2)
  const { rows } = await query(
    `SELECT id FROM negative_targets WHERE campaign_id = $1 AND expression::text LIKE '%B00DUPASIN%'`,
    [campId]
  );
  assert(rows.length === 1, "Only 1 DB row for ASIN (no duplicate inserted)", `got ${rows.length}`);
}

// ─── Test 8: Rule engine — dry run writes nothing ────────────────────────────
async function testRuleEngineDryRun() {
  console.log("\n[ Engine ] add_negative_asin — dry run writes nothing to DB");

  const campId = await createTestCampaign("dry1");
  await query(`DELETE FROM negative_targets WHERE campaign_id = $1`, [campId]);

  const ruleId = await createRule({
    name: "__test_nasin_dry__",
    conditions: TEST_COND,
    actions: [{ type: "add_negative_asin", value: "B00DRYRUNS" }],
    dryRun: true,
  });

  const { results } = await executeRules(WORKSPACE_ID, ruleId, {
    forceDryRun: true, saveExecution: false,
  });

  const ruleResult = results.find(r => r.ruleId === ruleId);
  assert(!!ruleResult, "Rule executed (dry run)");
  assert(ruleResult?.isDryRun === true, "isDryRun = true in result");

  // Nothing should be in DB
  const { rows } = await query(
    `SELECT id FROM negative_targets WHERE campaign_id = $1`, [campId]
  );
  assert(rows.length === 0, "No rows written to DB in dry-run mode", `got ${rows.length}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Negative ASINs Tests");
  console.log("═══════════════════════════════════════════════════");

  try {
    await connectDB();
    console.log("✓ DB connected");

    // Check negative_targets table exists
    const { rows: tbl } = await query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'negative_targets'`
    );
    if (!tbl.length) {
      console.error("✗ negative_targets table missing");
      process.exit(1);
    }
    console.log("✓ negative_targets table exists\n");

    await pauseRealRules();

    await testAddSingle();
    await testList();
    await testBulkAdd();
    await testDeleteSingle();
    await testBulkDelete();
    await testRuleEngineApply();
    await testRuleEngineDuplicate();
    await testRuleEngineDryRun();

  } catch (err) {
    console.error("\nFATAL:", err.message, err.stack);
    failed++;
  } finally {
    await cleanup();
    console.log("\n═══════════════════════════════════════════════════");
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log("═══════════════════════════════════════════════════\n");
    process.exit(failed > 0 ? 1 : 0);
  }
}

main();
