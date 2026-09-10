/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  testPathIgnorePatterns: ["/node_modules/", "/tests/integration/"],
  verbose: true,
  // Serial, and not only because `npm test` says --runInBand.
  //
  // 44 of these files drive the app through supertest, which binds a fresh ephemeral server per
  // request. Across nine parallel workers that churn exhausts sockets and one request in a few
  // thousand comes back "socket hang up" — a different test each time (adGroups, concurrency,
  // webhookRateLimit have all taken the hit), which reads like a real intermittent bug and is
  // not one. Running `npx jest` directly used to pick that up, roughly one run in eight; the
  // requirement belongs in the config rather than only in the npm script.
  maxWorkers: 1,
};
