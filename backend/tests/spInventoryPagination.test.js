"use strict";
/**
 * FBA inventory pagination survives an expired nextToken.
 *
 * The inventory walk pages through /fba/inventory/v1/summaries. A 429 mid-walk
 * parks the request in the shared retry wrapper for up to 90 seconds, which is
 * long enough for Amazon to expire the nextToken we are holding; the next page
 * then comes back 400 "Next token is invalid or expired" and the whole sync
 * fails (2026-09-08 04:20 UTC, SP_SYNC: inventory failed). Losing one page cost
 * the entire day's stock snapshot, which the out-of-stock cause detection in the
 * product-movers alert reads.
 */

jest.mock("axios");
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const axios = require("axios");
const logger = require("../src/config/logger");
const { getInventory } = require("../src/services/amazon/spClient");

const MKT = "A1PA6795UKMFR9";
const page = (skus, nextToken) => ({
  data: {
    payload: { inventorySummaries: skus.map(sellerSku => ({ sellerSku, asin: "B0TEST0001" })) },
    pagination: nextToken ? { nextToken } : {},
  },
});
const expiredToken = () => Object.assign(new Error("Request failed"), {
  response: { status: 400, data: { errors: [{ code: "InvalidInput", message: "Next token is invalid or expired" }] } },
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SP_API_CLIENT_ID = "id";
  process.env.SP_API_CLIENT_SECRET = "secret";
  // The LWA token exchange is a POST; every page is a GET.
  axios.post = jest.fn().mockResolvedValue({ data: { access_token: "tok", expires_in: 3600 } });
});

describe("getInventory", () => {
  it("returns every page of a clean walk", async () => {
    axios.get = jest.fn()
      .mockResolvedValueOnce(page(["SKU-1"], "t1"))
      .mockResolvedValueOnce(page(["SKU-2"], null));

    const items = await getInventory(MKT, "refresh");

    expect(items.map(i => i.sellerSku)).toEqual(["SKU-1", "SKU-2"]);
  });

  it("restarts the walk when the token expires mid-way, rather than losing the run", async () => {
    axios.get = jest.fn()
      .mockResolvedValueOnce(page(["SKU-1"], "t1"))
      .mockRejectedValueOnce(expiredToken())
      // Second walk, from page one.
      .mockResolvedValueOnce(page(["SKU-1"], "t1b"))
      .mockResolvedValueOnce(page(["SKU-2"], null));

    const items = await getInventory(MKT, "refresh");

    // No duplicated first page: the restart discards what the failed walk held.
    expect(items.map(i => i.sellerSku)).toEqual(["SKU-1", "SKU-2"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/nextToken expired/), expect.objectContaining({ marketplaceId: MKT })
    );
  });

  it("gives up after one restart instead of walking forever", async () => {
    axios.get = jest.fn()
      .mockResolvedValueOnce(page(["SKU-1"], "t1"))
      .mockRejectedValueOnce(expiredToken())
      .mockResolvedValueOnce(page(["SKU-1"], "t1b"))
      .mockRejectedValueOnce(expiredToken());

    await expect(getInventory(MKT, "refresh")).rejects.toThrow(/expired/i);
    expect(axios.get).toHaveBeenCalledTimes(4);
  });

  it("does not restart on an error that has nothing to do with the token", async () => {
    axios.get = jest.fn()
      .mockResolvedValueOnce(page(["SKU-1"], "t1"))
      .mockRejectedValueOnce(Object.assign(new Error("Request failed"), {
        response: { status: 500, data: { errors: [{ code: "InternalFailure", message: "boom" }] } },
      }));

    await expect(getInventory(MKT, "refresh")).rejects.toThrow(/InternalFailure|boom/);
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it("does not restart when the very first page fails — there is no token to blame", async () => {
    axios.get = jest.fn().mockRejectedValueOnce(expiredToken());

    await expect(getInventory(MKT, "refresh")).rejects.toThrow(/expired/i);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });
});
