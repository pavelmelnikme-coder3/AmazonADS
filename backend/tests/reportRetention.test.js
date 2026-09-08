"use strict";
/**
 * Amazon's report retention differs per ad product, and the backfill did not know it.
 *
 * On 2026-09-07 a search-term backfill queued 31-day chunks back to June. Sponsored
 * Products accepted every chunk (95 days of retention); Sponsored Brands rejected
 * 14 of them, and all the pipeline stored was "Request failed with status code 400".
 * Amazon's body actually says exactly what to do:
 *
 *   startDate (2026-06-09) must be equal to or after report type data retention
 *   start date (2026-07-10)
 *
 * — i.e. SB keeps 60 days (verified against the live API on 2026-09-08). So a chunk
 * that straddles the boundary still holds fetchable days: ask for those instead of
 * dropping the whole window, and treat a window entirely past retention as skipped
 * rather than as a failure that will be retried forever.
 */

jest.mock("axios");
jest.mock("../src/services/amazon/lwa", () => ({ getValidAccessToken: jest.fn().mockResolvedValue("tok") }));
jest.mock("../src/db/pool", () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const axios = require("axios");
const logger = require("../src/config/logger");
const { createReportRequest } = require("../src/services/amazon/reporting");

const profile = {
  connection_id: "conn-1", profile_id: "3504248839830151",
  marketplace_id: "A1PA6795UKMFR9", country_code: "DE", marketplace: "DE", timezone: "Europe/Berlin",
};
const retention400 = (requested, earliest) => Object.assign(new Error("Request failed with status code 400"), {
  response: {
    status: 400,
    data: {
      code: "400",
      detail: `startDate (${requested}) must be equal to or after report type data retention start date (${earliest})`,
    },
  },
});

beforeEach(() => jest.clearAllMocks());

describe("createReportRequest and Amazon's retention window", () => {
  it("re-asks from the earliest date Amazon still has, keeping the fetchable days", async () => {
    axios.post
      .mockRejectedValueOnce(retention400("2026-06-09", "2026-07-10"))
      .mockResolvedValueOnce({ data: { reportId: "rep-1" } });

    const id = await createReportRequest({
      profile, campaignType: "SB", reportLevel: "keyword",
      startDate: "2026-06-09", endDate: "2026-07-31",
    });

    expect(id).toBe("rep-1");
    const [, secondBody] = axios.post.mock.calls[1];
    expect(secondBody.startDate).toBe("2026-07-10");
    expect(secondBody.endDate).toBe("2026-07-31");
  });

  it("gives the retry a fresh name, so Amazon does not read it as the same request", async () => {
    // The request body is reused between attempts, so what each call actually
    // sent has to be snapshotted as it goes out — reading it afterwards would
    // only show the last state of the shared object.
    const sent = [];
    axios.post.mockImplementation((_url, body) => {
      sent.push({ ...body });
      return sent.length === 1
        ? Promise.reject(retention400("2026-06-09", "2026-07-10"))
        : Promise.resolve({ data: { reportId: "rep-1" } });
    });

    await createReportRequest({
      profile, campaignType: "SB", reportLevel: "keyword",
      startDate: "2026-06-09", endDate: "2026-07-31",
    });

    expect(sent).toHaveLength(2);
    expect(sent[1].name).not.toBe(sent[0].name);
    expect(sent[0].startDate).toBe("2026-06-09");
    expect(sent[1].startDate).toBe("2026-07-10");
    expect(sent[1].name).toContain("2026-07-10");
  });

  it("tells the caller which window was actually requested", async () => {
    axios.post
      .mockRejectedValueOnce(retention400("2026-06-09", "2026-07-10"))
      .mockResolvedValueOnce({ data: { reportId: "rep-1" } });
    const onWindowClamped = jest.fn();

    await createReportRequest({
      profile, campaignType: "SB", reportLevel: "keyword",
      startDate: "2026-06-09", endDate: "2026-07-31", onWindowClamped,
    });

    expect(onWindowClamped).toHaveBeenCalledWith("2026-07-10");
  });

  it("marks a window that is entirely past retention as expired, not as a bare 400", async () => {
    axios.post.mockRejectedValue(retention400("2026-06-09", "2026-07-10"));

    await expect(createReportRequest({
      profile, campaignType: "SB", reportLevel: "keyword",
      startDate: "2026-06-09", endDate: "2026-07-09",
    })).rejects.toMatchObject({ retentionExpired: true });

    // Nothing to fetch means nothing to re-ask for.
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it("does not loop when Amazon rejects the clamped window too", async () => {
    axios.post
      .mockRejectedValueOnce(retention400("2026-06-09", "2026-07-10"))
      .mockRejectedValueOnce(retention400("2026-07-10", "2026-07-11"));

    await expect(createReportRequest({
      profile, campaignType: "SB", reportLevel: "keyword",
      startDate: "2026-06-09", endDate: "2026-07-31",
    })).rejects.toThrow(/400/);
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it("carries Amazon's own explanation into the error the failed row will store", async () => {
    axios.post.mockRejectedValue(Object.assign(new Error("Request failed with status code 400"), {
      response: { status: 400, data: { code: "400", detail: "columns contains an unsupported value" } },
    }));

    await expect(createReportRequest({
      profile, campaignType: "SP", reportLevel: "keyword",
      startDate: "2026-09-01", endDate: "2026-09-07",
    })).rejects.toThrow(/columns contains an unsupported value/);
  });

  it("leaves an in-retention request untouched", async () => {
    axios.post.mockResolvedValueOnce({ data: { reportId: "rep-2" } });

    const id = await createReportRequest({
      profile, campaignType: "SP", reportLevel: "keyword",
      startDate: "2026-08-10", endDate: "2026-09-06",
    });

    expect(id).toBe("rep-2");
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
