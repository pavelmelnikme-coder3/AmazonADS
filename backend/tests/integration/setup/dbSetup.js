"use strict";
// setupFiles: runs in each test worker process BEFORE modules are loaded.
// Setting DATABASE_URL here ensures pool.js connects to the test DB.
const { TEST_DB_URL } = require("./testConfig");
process.env.DATABASE_URL = TEST_DB_URL;
process.env.NODE_ENV = "test";
// Suppress redis errors — tests don't need Redis
process.env.REDIS_URL = "redis://localhost:6380"; // non-existent port, will error silently
