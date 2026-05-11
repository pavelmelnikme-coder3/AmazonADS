"use strict";
const { spawnSync } = require("child_process");
const { PG_CONTAINER } = require("./testConfig");

module.exports = async function globalTeardown() {
  console.log("\n── Stopping test PostgreSQL container… ─────────────────────────");
  spawnSync("docker", ["rm", "-f", PG_CONTAINER], { stdio: "pipe" });
  console.log("Done.\n");
};
