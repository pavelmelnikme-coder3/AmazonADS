"use strict";
/**
 * Jungle Scout client — response parsing
 *
 * Guards the field-name contract between the JS API and the rest of the app:
 *   - JS exposes its own relevance under `relevancy_score`; the app reads
 *     `relevance_score` everywhere (merge/sort/filter, frontend, export). The
 *     parser must map it, otherwise JS relevance is silently dropped.
 *   - search volume falls back exact → broad → approximate_30_day.
 *   - getRanksByAsin yields position + search_volume per ranked keyword.
 */

jest.mock("axios", () => ({ post: jest.fn() }));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const axios = require("axios");

// JS client gates every call on isConfigured() → both env vars present
process.env.JUNGLE_SCOUT_KEY_NAME = "test_key";
process.env.JUNGLE_SCOUT_API_KEY  = "test_secret";

const { getKeywordsByAsin, getKeywordsByKeyword, getRanksByAsin } =
  require("../src/services/junglescout/client");

const DE = "A1PA6795UKMFR9";

beforeEach(() => jest.clearAllMocks());

describe("parseKeywords field mapping", () => {
  test("maps JS relevancy_score → relevance_score (not the unused relevancy_score)", async () => {
    axios.post.mockResolvedValueOnce({
      data: { data: [
        { attributes: {
          name: "gaskocher camping",
          monthly_search_volume_exact: 34948,
          relevancy_score: 43,
          ease_of_ranking_score: 80,
        } },
      ] },
    });

    const [kw] = await getKeywordsByAsin(["B0C5Y2QCM6"], DE);

    expect(kw.relevance_score).toBe(43);          // mapped, displayable
    expect(kw).not.toHaveProperty("relevancy_score"); // old dead field gone
    expect(kw.ease_of_ranking).toBe(80);
    expect(kw.monthly_search_volume).toBe(34948);
    expect(kw.source).toBe("jungle_scout_asin");
  });

  test("relevance_score is null (not undefined) when JS omits relevancy_score", async () => {
    axios.post.mockResolvedValueOnce({
      data: { data: [{ attributes: { name: "no score kw", monthly_search_volume_exact: 100 } }] },
    });

    const [kw] = await getKeywordsByKeyword("seed", DE);

    expect(kw.relevance_score).toBeNull();
    expect(kw.ease_of_ranking).toBeNull();
  });

  test("search volume falls back exact → broad → approximate_30_day", async () => {
    axios.post.mockResolvedValueOnce({
      data: { data: [
        { attributes: { name: "a", monthly_search_volume_exact: 10 } },
        { attributes: { name: "b", monthly_search_volume_broad: 20 } },
        { attributes: { name: "c", approximate_30_day_search_volume: 30 } },
        { attributes: { name: "d" } },
      ] },
    });

    const out = await getKeywordsByAsin(["B0X"], DE);
    expect(out.map(k => k.monthly_search_volume)).toEqual([10, 20, 30, null]);
  });

  test("drops items without a keyword name", async () => {
    axios.post.mockResolvedValueOnce({
      data: { data: [
        { attributes: { relevancy_score: 90 } },          // no name → dropped
        { attributes: { name: "kept", relevancy_score: 50 } },
      ] },
    });

    const out = await getKeywordsByAsin(["B0X"], DE);
    expect(out).toHaveLength(1);
    expect(out[0].keyword_text).toBe("kept");
  });
});

describe("getRanksByAsin", () => {
  test("returns position + search_volume only for ranked keywords (organic_rank > 0)", async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        data: [
          { attributes: { name: "RankedKW", organic_rank: 9, monthly_search_volume_exact: 450 } },
          { attributes: { name: "unranked", organic_rank: 0 } },
          { attributes: { name: "missing-rank" } },
        ],
        links: {},
      },
    });

    const map = await getRanksByAsin("B0C5Y2QCM6", DE);
    expect(map.size).toBe(1);
    const entry = map.get("rankedkw");
    expect(entry).toMatchObject({ position: 9, found: true, search_volume: 450 });
  });
});
