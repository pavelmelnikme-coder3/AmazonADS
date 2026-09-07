"use strict";
/**
 * Overpass transport resilience.
 *
 * The public Overpass instance rate-limits by REFUSING the TCP connection, not by answering
 * 429. Node reports that as ECONNREFUSED with an EMPTY message, so it used to fall through to
 * the permanent "Search service unavailable" branch, never be retried, and log as
 * `{"error":""}` — naming neither the cause nor the endpoint.
 *
 * Live consequence on 2026-09-07: a 304-tile search over Germany was refused after roughly
 * five tiles and then walked 237 more at full speed collecting nothing, on its way to
 * reporting itself `completed` with 6 results — which reads exactly like "Germany has six
 * Asian restaurants".
 */
jest.mock("axios");
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const axios = require("axios");
const { searchBusinesses } = require("../src/services/leadFinder/overpass");

const BBOX = { south: 1, west: 2, north: 3, east: 4 };
const QUERY = "asiatisches restaurant";

const refused = (code = "ECONNREFUSED") => Object.assign(new Error(""), { code });
const busyStatus = (status) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
const oneResult = {
  data: { elements: [{ type: "node", id: 1, lat: 48.1, lon: 11.5,
    tags: { name: "Panda", amenity: "restaurant", cuisine: "asian" } }] },
};

// The retry path sleeps between attempts; run it on fake timers so the suite stays fast.
async function runWithTimers(promiseFactory) {
  jest.useFakeTimers();
  const p = promiseFactory();
  const settled = p.then(v => ({ ok: v }), e => ({ err: e }));
  // Let each pending sleep elapse; a few passes covers every retry delay.
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(30000);
  }
  const out = await settled;
  jest.useRealTimers();
  return out;
}

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.useRealTimers());

describe("connection-level refusals are retried like a busy status", () => {
  test.each(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"])(
    "%s is retried and the search still succeeds", async (code) => {
      axios.post.mockRejectedValueOnce(refused(code)).mockResolvedValueOnce(oneResult);
      const { ok, err } = await runWithTimers(() => searchBusinesses({ bbox: BBOX, query: QUERY }));
      expect(err).toBeUndefined();
      expect(ok).toHaveLength(1);
      expect(axios.post).toHaveBeenCalledTimes(2);
    });

  test("a busy HTTP status is still retried, as before", async () => {
    axios.post.mockRejectedValueOnce(busyStatus(429)).mockResolvedValueOnce(oneResult);
    const { ok } = await runWithTimers(() => searchBusinesses({ bbox: BBOX, query: QUERY }));
    expect(ok).toHaveLength(1);
  });

  test("exhausting the retries flags the provider as busy so the caller can stop the run", async () => {
    axios.post.mockRejectedValue(refused());
    const { err } = await runWithTimers(() => searchBusinesses({ bbox: BBOX, query: QUERY }));
    expect(err).toBeDefined();
    expect(err.overpassBusy).toBe(true);
    expect(axios.post.mock.calls.length).toBeGreaterThan(1);
  });

  test("a client-side timeout is NOT retried — the same query would just be slow again", async () => {
    axios.post.mockRejectedValue(Object.assign(new Error("timeout of 30000ms"), { code: "ECONNABORTED" }));
    const { err } = await runWithTimers(() => searchBusinesses({ bbox: BBOX, query: QUERY }));
    expect(err.message).toMatch(/timed out/);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test("a real 4xx is not retried either — it will not fix itself", async () => {
    axios.post.mockRejectedValue(busyStatus(400));
    const { err } = await runWithTimers(() => searchBusinesses({ bbox: BBOX, query: QUERY }));
    expect(err.message).toMatch(/unavailable/);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test("a 200 carrying Overpass's own timeout remark is surfaced, not read as 'no results'", async () => {
    axios.post.mockResolvedValue({ data: { remark: "runtime error: Query timed out", elements: [] } });
    const { err } = await runWithTimers(() => searchBusinesses({ bbox: BBOX, query: QUERY }));
    expect(err.message).toMatch(/too large|timed out/);
  });
});
