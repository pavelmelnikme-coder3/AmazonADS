"use strict";
/**
 * Jest globalSetup — runs once before all integration tests (separate Node process).
 * Starts a Docker PostgreSQL container, runs all migrations, prepares test DB.
 */

const { execSync, spawnSync } = require("child_process");
const { Pool }    = require("pg");
const fs          = require("fs");
const path        = require("path");
const { PG_CONTAINER, PG_PORT, TEST_DB_URL } = require("./testConfig");

const MIGRATIONS_DIR = path.join(__dirname, "../../../src/db/migrations");

module.exports = async function globalSetup() {
  console.log("\n── Integration test setup ──────────────────────────────────────");

  // ── 1. Remove stale container ───────────────────────────────────────────────
  spawnSync("docker", ["rm", "-f", PG_CONTAINER], { stdio: "pipe" });

  // ── 2. Start fresh container ────────────────────────────────────────────────
  console.log(`Starting PostgreSQL container on port ${PG_PORT}…`);
  execSync(
    `docker run -d --name ${PG_CONTAINER} ` +
    `-e POSTGRES_DB=adsflow_test ` +
    `-e POSTGRES_USER=postgres ` +
    `-e POSTGRES_PASSWORD=testpass ` +
    `-p ${PG_PORT}:5432 ` +
    `postgres:15-alpine`,
    { stdio: "pipe" }
  );

  // ── 3. Wait for PostgreSQL to accept connections (max 30s) ──────────────────
  console.log("Waiting for PostgreSQL to be ready…");
  const tempPool = new Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 2000 });
  for (let i = 0; i < 30; i++) {
    try {
      await tempPool.query("SELECT 1");
      break;
    } catch {
      if (i === 29) throw new Error("PostgreSQL did not start within 30 seconds");
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // ── 4. Run all migrations in order ──────────────────────────────────────────
  console.log("Running migrations…");
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();

  await tempPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const { rows: applied } = await tempPool.query("SELECT filename FROM schema_migrations");
  const appliedSet = new Set(applied.map(r => r.filename));

  for (const file of files) {
    if (appliedSet.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    try {
      await tempPool.query(sql);
      await tempPool.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
        [file]
      );
      console.log(`  ✓ ${file}`);
    } catch (err) {
      console.warn(`  ⚠ ${file}: ${err.message.split("\n")[0]}`);
    }
  }

  // ── 5. Create 2027 partition for fact_metrics_daily (current date may need it) ─
  try {
    await tempPool.query(`
      CREATE TABLE IF NOT EXISTS fact_metrics_daily_2027
        PARTITION OF fact_metrics_daily
        FOR VALUES FROM ('2027-01-01') TO ('2028-01-01')
    `);
  } catch {}

  // ── 6. Disable audit immutability trigger so tests can clean audit_events ───
  try {
    await tempPool.query(
      "ALTER TABLE audit_events DISABLE TRIGGER audit_immutable"
    );
  } catch {}

  await tempPool.end();
  console.log("Test database ready.\n");
};
