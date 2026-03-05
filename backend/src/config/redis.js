const { Redis } = require("ioredis");
const logger = require("./logger");

let redis = null;

async function connectRedis() {
  redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: null, // Required for BullMQ
    enableReadyCheck: false,
    lazyConnect: true,
  });

  redis.on("error", (err) => logger.error("Redis error", { error: err.message }));
  redis.on("connect", () => logger.debug("Redis connected"));

  await redis.connect();
  return redis;
}

function getRedis() {
  if (!redis) throw new Error("Redis not initialized. Call connectRedis() first.");
  return redis;
}

// BullMQ needs a separate connection per queue/worker
function createRedisConnection() {
  return new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

module.exports = { connectRedis, getRedis, createRedisConnection };
