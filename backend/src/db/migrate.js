/**
 * Migration runner — applies pending SQL migrations on startup.
 * Tracks applied migrations in schema_migrations table.
 * All migration files must be idempotent (use IF NOT EXISTS guards).
 */

const fs = require("fs");
const path = require("path");
const { query } = require("./pool");
const logger = require("../config/logger");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

// Migrations applied via docker-entrypoint-initdb.d on first init
const LEGACY_MIGRATIONS = [
  "001_initial.sql",
  "002_add_region.sql",
  "003_rules_alerts.sql",
  "004_extended_entities.sql",
];

async function runMigrations() {
  // Create tracking table
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const { rows: applied } = await query("SELECT filename FROM schema_migrations");
  const appliedSet = new Set(applied.map((r) => r.filename));

  // Auto-mark legacy migrations as applied if the DB is already initialized
  // (they were run via docker-entrypoint-initdb.d)
  if (!appliedSet.has("001_initial.sql")) {
    const { rows } = await query(
      "SELECT EXISTS(SELECT FROM information_schema.tables WHERE table_name = 'rules') AS exists"
    );
    if (rows[0].exists) {
      for (const legacy of LEGACY_MIGRATIONS) {
        await query(
          "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
          [legacy]
        );
        appliedSet.add(legacy);
        logger.info(`Migration auto-marked (legacy): ${legacy}`);
      }
    }
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) {
      logger.info(`Migration already applied: ${file}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    logger.info(`Running migration: ${file}`);
    try {
      await query(sql);
      await query("INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
      logger.info(`Migration complete: ${file}`);
    } catch (e) {
      logger.error(`Migration failed: ${file}`, { error: e.message });
      throw e;
    }
  }

  logger.info("All migrations up to date");
}

module.exports = { runMigrations };
