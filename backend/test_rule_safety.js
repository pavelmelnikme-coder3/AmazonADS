/**
 * Rule Engine Safety Test
 * Tests all three conflict-prevention layers:
 *   Layer 1 — Priority ordering
 *   Layer 2 — Within-run entity lock
 *   Layer 3 — Cross-run cooldown
 * Plus: worker job deduplication
 *
 * Strategy: creates isolated test campaigns with daily_budget = 1234567.89
 * (unique value → condition matches ONLY these campaigns, not real ones).
 * Campaigns have no keywords → tryApiUpdate returns early, zero Amazon API calls.
 */

const { query, connectDB } = require("./src/db/pool");
const { executeRules }     = require("./src/services/rules/engine");
const { getQueue, QUEUES, queueRuleExecution } = require("./src/jobs/workers");

const WORKSPACE_ID = "05831bc2-b7b3-44f2-a3e2-149ad0759627";
const PROFILE_ID   = "1fa69533-8970-4bb8-bcf3-6fcc016fc707";
// Unique budget value — only our test campaigns will have it
const TEST_BUDGET  = 1234567.89;
const TEST_COND    = [{ field: "daily_budget", operator: "gte", value: 1234560 }];

let passed = 0;
let failed = 0;
const createdRuleIds     = [];
const createdCampaignIds = [];
let pausedRuleIds        = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function assert(condition, label, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

async function createTestCampaign(nameSuffix) {
  const { rows: [c] } = await query(
    `INSERT INTO campaigns
       (workspace_id, profile_id, name, state, daily_budget, campaign_type, amazon_campaign_id)
     VALUES ($1, $2, $3, 'paused', $4, 'sponsoredProducts', $5)
     RETURNING id`,
    [WORKSPACE_ID, PROFILE_ID, `__test_${nameSuffix}__`, TEST_BUDGET, `TEST_${nameSuffix}_${Date.now()}`]
  );
  createdCampaignIds.push(c.id);
  return c.id;
}

async function createRule({ name, priority, conditions, actions, dryRun = false }) {
  const { rows: [rule] } = await query(
    `INSERT INTO rules (workspace_id, name, is_active, conditions, actions, dry_run, priority, schedule_type)
     VALUES ($1, $2, true, $3, $4, $5, $6, 'manual')
     RETURNING id`,
    [WORKSPACE_ID, name, JSON.stringify(conditions), JSON.stringify(actions), dryRun, priority]
  );
  createdRuleIds.push(rule.id);
  return rule.id;
}

async function pauseRealRules() {
  // Disable all existing rules so only test rules run during tests
  const { rows } = await query(
    `UPDATE rules SET is_active = false
     WHERE workspace_id = $1 AND name NOT LIKE '__test_%'
     RETURNING id`,
    [WORKSPACE_ID]
  );
  pausedRuleIds = rows.map(r => r.id);
  console.log(`  (paused ${pausedRuleIds.length} existing rules during tests)`);
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
    await query(`DELETE FROM rule_entity_cooldowns WHERE entity_id = ANY($1::uuid[])`, [createdCampaignIds]);
    await query(`DELETE FROM campaigns WHERE id = ANY($1::uuid[])`, [createdCampaignIds]);
  }
  try {
    const queue = getQueue(QUEUES.RULE_EXECUTION);
    await queue.drain();
  } catch (_) {}
}

// ─── Test 1: Priority ordering ────────────────────────────────────────────────
async function testPriorityOrdering() {
  console.log("\n[ Layer 1 ] Priority ordering");

  // 3 rules with different priorities — all match test campaigns (forceDryRun)
  const idHigh = await createRule({
    name: "__test_pri_high__", priority: 80,
    conditions: TEST_COND,
    actions: [{ type: "adjust_bid", value: 5 }],
    dryRun: true,
  });
  const idMid = await createRule({
    name: "__test_pri_mid__", priority: 50,
    conditions: TEST_COND,
    actions: [{ type: "adjust_bid", value: 5 }],
    dryRun: true,
  });
  const idLow = await createRule({
    name: "__test_pri_low__", priority: 20,
    conditions: TEST_COND,
    actions: [{ type: "adjust_bid", value: 5 }],
    dryRun: true,
  });

  await createTestCampaign("pri_a");
  await createTestCampaign("pri_b");

  const { results } = await executeRules(WORKSPACE_ID, null, {
    forceDryRun: true, saveExecution: false,
  });

  const testResults = results.filter(r => [idHigh, idMid, idLow].includes(r.ruleId));
  const priorities  = testResults.map(r => r.priority);

  assert(testResults.length === 3, "All 3 test rules executed",
    `got ${testResults.length}`);
  assert(
    priorities[0] >= priorities[1] && priorities[1] >= priorities[2],
    "Rules executed in priority DESC order",
    `order: ${priorities.join(" → ")}`
  );
  assert(
    testResults[0].ruleId === idHigh,
    "Highest-priority rule ran first"
  );
}

// ─── Test 2: Within-run entity lock (Layer 2) ─────────────────────────────────
async function testWithinRunLock() {
  console.log("\n[ Layer 2 ] Within-run entity lock");

  // 3 isolated test campaigns (no keywords → no API calls)
  const c1 = await createTestCampaign("lock_a");
  const c2 = await createTestCampaign("lock_b");
  const c3 = await createTestCampaign("lock_c");

  // Clear any leftover cooldowns for these entities
  await query(`DELETE FROM rule_entity_cooldowns WHERE entity_id = ANY($1::uuid[])`,
    [[c1, c2, c3]]);

  const idHigh = await createRule({
    name: "__test_lock_high__", priority: 90,
    conditions: TEST_COND,
    actions: [{ type: "adjust_bid", value: 1 }],
    dryRun: false,
  });
  const idLow = await createRule({
    name: "__test_lock_low__", priority: 10,
    conditions: TEST_COND,
    actions: [{ type: "adjust_bid", value: 1 }],
    dryRun: false,
  });

  const { results } = await executeRules(WORKSPACE_ID, null, {
    forceDryRun: false, saveExecution: false,
  });

  const highResult = results.find(r => r.ruleId === idHigh);
  const lowResult  = results.find(r => r.ruleId === idLow);

  assert(!!highResult, "High-priority rule executed");
  assert(!!lowResult,  "Low-priority rule executed");

  if (highResult && lowResult) {
    // Count only our test campaigns in summaries
    const testIds  = [c1, c2, c3];
    const hApplied = highResult.summary.filter(s => s.applied   && testIds.includes(s.entityId)).length;
    const lApplied = lowResult.summary.filter( s => s.applied   && testIds.includes(s.entityId)).length;
    const lSkipped = lowResult.summary.filter( s => s.skipped   && testIds.includes(s.entityId)).length;

    assert(hApplied === 3, `High-priority rule applied to all 3 test campaigns`, `applied=${hApplied}`);
    assert(lApplied === 0, `Low-priority rule applied 0 actions (blocked by Layer 2)`, `applied=${lApplied}`);
    assert(lSkipped === 3, `Low-priority rule skipped all 3 test campaigns`, `skipped=${lSkipped}`);

    const skipEntry = lowResult.summary.find(s => s.skipped && testIds.includes(s.entityId));
    assert(
      skipEntry?.reason?.includes("already modified this cycle"),
      "Skip reason: 'already modified this cycle by higher-priority rule'",
      `reason: "${skipEntry?.reason}"`
    );
  }
}

// ─── Test 3: Cross-run cooldown (Layer 3) ─────────────────────────────────────
async function testCrossRunCooldown() {
  console.log("\n[ Layer 3 ] Cross-run cooldown");

  // Isolated test campaign
  const cId = await createTestCampaign("cooldown");
  await query(`DELETE FROM rule_entity_cooldowns WHERE entity_id = $1`, [cId]);

  const ruleId = await createRule({
    name: "__test_cooldown__", priority: 50,
    conditions: TEST_COND,
    actions: [{ type: "adjust_bid", value: 1 }],
    dryRun: false,
  });

  // ── Run 1: should apply ───────────────────────────────────────────────────
  const run1 = await executeRules(WORKSPACE_ID, ruleId, {
    forceDryRun: false, saveExecution: false,
  });
  const r1 = run1.results.find(r => r.ruleId === ruleId);
  const applied1 = r1?.summary?.filter(s => s.applied && s.entityId === cId).length ?? 0;

  assert(applied1 === 1, "Run 1: action applied to test campaign", `applied=${applied1}`);

  // ── Verify cooldown row written ───────────────────────────────────────────
  const { rows: [cdRow] } = await query(
    `SELECT locked_until, action_category FROM rule_entity_cooldowns
     WHERE workspace_id = $1 AND entity_id = $2`,
    [WORKSPACE_ID, cId]
  );
  assert(!!cdRow, "Cooldown row written after Run 1");

  if (cdRow) {
    const expiry = new Date(cdRow.locked_until);
    const remainMin = Math.round((expiry - Date.now()) / 60000);
    assert(expiry > new Date(), "locked_until is in the future");
    assert(remainMin >= 55, `Cooldown ~1 hour for 'bid' category`, `remaining: ${remainMin} min`);
    assert(cdRow.action_category === "bid", "action_category = 'bid'");
    console.log(`    → Expires in ${remainMin} min`);
  }

  // ── Run 2: should skip (on cooldown) ─────────────────────────────────────
  const run2 = await executeRules(WORKSPACE_ID, ruleId, {
    forceDryRun: false, saveExecution: false,
  });
  const r2 = run2.results.find(r => r.ruleId === ruleId);
  const applied2 = r2?.summary?.filter(s => s.applied  && s.entityId === cId).length ?? 0;
  const skipped2 = r2?.summary?.filter(s => s.skipped  && s.entityId === cId).length ?? 0;

  assert(applied2 === 0, "Run 2: 0 actions applied (entity on cooldown)", `applied=${applied2}`);
  assert(skipped2 === 1, "Run 2: test campaign skipped due to cooldown", `skipped=${skipped2}`);

  const skipEntry = r2?.summary?.find(s => s.skipped && s.entityId === cId);
  assert(
    skipEntry?.reason?.includes("on cooldown"),
    "Skip reason references cooldown",
    `reason: "${skipEntry?.reason}"`
  );

  // ── Run 3: forceDryRun should bypass cooldown ─────────────────────────────
  const run3 = await executeRules(WORKSPACE_ID, ruleId, {
    forceDryRun: true, saveExecution: false,
  });
  const r3 = run3.results.find(r => r.ruleId === ruleId);
  const skipped3 = r3?.summary?.filter(s => s.skipped && s.entityId === cId).length ?? 0;
  assert(
    skipped3 === 0,
    "forceDryRun (preview) ignores cooldowns — campaign NOT skipped",
    `skipped in dry run: ${skipped3}`
  );
}

// ─── Test 4: Worker job deduplication ─────────────────────────────────────────
async function testJobDeduplication() {
  console.log("\n[ Worker ] Job deduplication");

  const queue = getQueue(QUEUES.RULE_EXECUTION);
  await queue.drain();

  const job1 = await queueRuleExecution(WORKSPACE_ID, null);
  const job2 = await queueRuleExecution(WORKSPACE_ID, null);

  // Job may already be in active/waiting — check both states
  const [waiting, active] = await Promise.all([queue.getWaiting(), queue.getActive()]);
  const allJobs = [...waiting, ...active].filter(j => j.data.workspaceId === WORKSPACE_ID);

  assert(allJobs.length <= 1,
    "At most 1 job in queue/active after 2 identical enqueue calls",
    `found ${allJobs.length} jobs`
  );
  assert(job1.id === job2.id,
    "Both calls return the same job ID",
    `job1=${job1.id}, job2=${job2.id}`
  );

  await queue.drain();
}

// ─── Test 5: State-change conflict ────────────────────────────────────────────
async function testStateConflict() {
  console.log("\n[ Layer 2 ] State-change conflict (pause vs enable)");

  const c1 = await createTestCampaign("state_a");
  const c2 = await createTestCampaign("state_b");
  await query(`DELETE FROM rule_entity_cooldowns WHERE entity_id = ANY($1::uuid[])`,
    [[c1, c2]]);

  const pauseId  = await createRule({
    name: "__test_pause__", priority: 70,
    conditions: TEST_COND,
    actions: [{ type: "pause_campaign" }],
    dryRun: false,
  });
  const enableId = await createRule({
    name: "__test_enable__", priority: 30,
    conditions: TEST_COND,
    actions: [{ type: "enable_campaign" }],
    dryRun: false,
  });

  const { results } = await executeRules(WORKSPACE_ID, null, {
    forceDryRun: false, saveExecution: false,
  });

  const pauseR  = results.find(r => r.ruleId === pauseId);
  const enableR = results.find(r => r.ruleId === enableId);

  if (pauseR && enableR) {
    const testIds    = [c1, c2];
    const pApplied   = pauseR.summary.filter(s => s.applied  && testIds.includes(s.entityId)).length;
    const eApplied   = enableR.summary.filter(s => s.applied  && testIds.includes(s.entityId)).length;
    const eSkipped   = enableR.summary.filter(s => s.skipped  && testIds.includes(s.entityId)).length;

    assert(pApplied === 2,  "Higher-priority 'pause' applied to both test campaigns");
    assert(eApplied === 0,  "Lower-priority 'enable' applied 0 (blocked by pause)", `applied=${eApplied}`);
    assert(eSkipped === 2,  "Lower-priority 'enable' skipped both test campaigns",  `skipped=${eSkipped}`);
  }

  // Restore test campaigns back to paused (they were paused before the test)
  await query(`UPDATE campaigns SET state = 'paused' WHERE id = ANY($1::uuid[])`, [[c1, c2]]);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Rule Engine Safety Tests");
  console.log("═══════════════════════════════════════════════════");

  try {
    await connectDB();
    console.log("✓ DB connected");

    const { rows: pCol } = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'rules' AND column_name = 'priority'`);
    const { rows: cdTable } = await query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_name = 'rule_entity_cooldowns'`);

    if (!pCol.length || !cdTable.length) {
      console.error("✗ Migration 013 not applied (priority column or cooldowns table missing)");
      process.exit(1);
    }
    console.log("✓ Migration 013 applied\n");

    await pauseRealRules();

    await testPriorityOrdering();
    await testWithinRunLock();
    await testCrossRunCooldown();
    await testJobDeduplication();
    await testStateConflict();

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
