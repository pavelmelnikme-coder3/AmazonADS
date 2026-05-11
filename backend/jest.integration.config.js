/** @type {import('jest').Config} */
module.exports = {
  testMatch: ["**/tests/integration/**/*.test.js"],
  testTimeout: 30000,
  globalSetup:    "./tests/integration/setup/globalSetup.js",
  globalTeardown: "./tests/integration/setup/globalTeardown.js",
  setupFiles: ["./tests/integration/setup/dbSetup.js"],
  testEnvironment: "node",
  verbose: true,
  forceExit: true,
};
