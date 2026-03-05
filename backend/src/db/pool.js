const { Pool } = require("pg");
const logger = require("../config/logger");

let pool = null;

async function connectDB() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  });

  pool.on("error", (err) => logger.error("Unexpected PG pool error", { error: err.message }));

  // Verify connection
  const client = await pool.connect();
  await client.query("SELECT 1");
  client.release();
  return pool;
}

function getPool() {
  if (!pool) throw new Error("Database not initialized");
  return pool;
}

/**
 * Execute a query. Returns pg QueryResult.
 * @param {string} text - SQL query
 * @param {any[]} params - query parameters
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await getPool().query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn("Slow query", { duration, query: text.substring(0, 100) });
    }
    return result;
  } catch (err) {
    logger.error("DB query error", { error: err.message, query: text.substring(0, 100) });
    throw err;
  }
}

/**
 * Run multiple queries in a transaction.
 * @param {Function} fn - async function receiving { query } scoped to the transaction client
 */
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn({
      query: (text, params) => client.query(text, params),
    });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { connectDB, getPool, query, withTransaction };
