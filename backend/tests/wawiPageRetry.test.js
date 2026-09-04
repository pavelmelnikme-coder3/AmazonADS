"use strict";
/**
 * wawiGetPagesParallel — a slow page must not abort the whole sync step.
 *
 * Later pages were already tolerant: a failure is logged and skipped. Page 1 was not — it was
 * fetched bare, so one slow response threw out of the pager and killed the step. Live effect:
 * "Wawi sync step failed: items — timeout of 90000ms exceeded" on every run (8×/day), leaving
 * the item catalog unsynced each time. Item objects are heavy (~0.6 s each to serialise), so
 * an occasional slow page is normal.
 *
 * Wawi is the live production ERP and strictly read-only to AdsFlow, so retrying a GET is safe.
 */

jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock("axios", () => ({ get: jest.fn(), post: jest.fn() }));

const axios = require("axios");
const { wawiGetPagesParallel } = require("../src/services/wawi/client");

const CONN = { base_url: "https://wawi.example:64110", app_id: "AdsFlowWawi", app_secret: "s" };
const page = (n, totalPages) => ({
  data: { Items: [{ Id: n }], TotalPages: totalPages, TotalItems: totalPages },
});

beforeEach(() => { jest.clearAllMocks(); });

// Real backoff is seconds; the tests only care that a retry happens, not how long it waits.
const OPTS = { retryDelayMs: 1 };

describe("wawiGetPagesParallel", () => {
  it("retries a first page that times out instead of failing the step", async () => {
    axios.get
      .mockRejectedValueOnce(new Error("timeout of 90000ms exceeded"))
      .mockResolvedValueOnce(page(1, 1));

    const seen = [];
    const total = await wawiGetPagesParallel(CONN, "/items", {}, async (items) => { seen.push(...items); }, OPTS);

    expect(total).toBe(1);
    expect(seen).toHaveLength(1);
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry budget and surfaces the original error", async () => {
    axios.get.mockRejectedValue(new Error("timeout of 90000ms exceeded"));
    await expect(wawiGetPagesParallel(CONN, "/items", {}, async () => {}, OPTS))
      .rejects.toThrow("timeout of 90000ms exceeded");
    expect(axios.get).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("retries a later page too, rather than silently dropping its items", async () => {
    axios.get
      .mockResolvedValueOnce(page(1, 2))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(page(2, 2));

    const seen = [];
    const total = await wawiGetPagesParallel(CONN, "/items", {}, async (items) => { seen.push(...items); }, OPTS);

    expect(total).toBe(2);
    expect(seen.map(i => i.Id).sort()).toEqual([1, 2]);
  });

  it("still skips a page that keeps failing, keeping the pages that worked", async () => {
    axios.get
      .mockResolvedValueOnce(page(1, 2))
      .mockRejectedValue(new Error("timeout of 90000ms exceeded"));

    const seen = [];
    const total = await wawiGetPagesParallel(CONN, "/items", {}, async (items) => { seen.push(...items); }, OPTS);

    expect(total).toBe(1);
    expect(seen.map(i => i.Id)).toEqual([1]);
  });

  it("does not retry a page that succeeds", async () => {
    axios.get.mockResolvedValueOnce(page(1, 1));
    await wawiGetPagesParallel(CONN, "/items", {}, async () => {}, OPTS);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it("only ever issues GETs — Wawi is read-only to us", async () => {
    axios.get
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(page(1, 1));
    await wawiGetPagesParallel(CONN, "/items", {}, async () => {}, OPTS);
    expect(axios.post).not.toHaveBeenCalled();
  });
});
