"use strict";
/**
 * `?page=` / `?limit=` reach SQL by interpolation — `LIMIT ${limit} OFFSET ${offset}` — so they
 * have to be numbers, and the three list routes each had their own copy of arithmetic that did
 * not guarantee it:
 *
 *   ?page=abc   Math.max(NaN, 1) is NaN, not 1 → `OFFSET NaN` → Postgres: column "nan" does not
 *               exist. A 500 on a URL a user can type.
 *   ?limit=-5   -5 is truthy so `|| 500` never fires, and the clamp only capped the top end →
 *               `LIMIT -5` → Postgres: LIMIT must not be negative.
 *
 * Both were reproduced against the live database before this was written.
 */
const { paginate } = require("../src/routes/_pagination");

const D = { defaultLimit: 500, maxLimit: 2000 };

describe("the values that used to reach SQL as NaN", () => {
  test.each(["abc", "", " ", "null", "undefined", "NaN", "e5", "--1"])(
    "page=%p yields a finite offset", (page) => {
      const { offset, page: p } = paginate({ page }, D);
      expect(Number.isFinite(offset)).toBe(true);
      expect(offset).toBe(0);
      expect(p).toBe(1);
    });

  test.each([undefined, null])("a missing page is page 1", (page) => {
    expect(paginate({ page }, D)).toEqual({ limit: 500, offset: 0, page: 1 });
  });
});

describe("the values that used to reach SQL as a negative LIMIT", () => {
  test.each([["-5", 1], ["-1", 1], ["0", 1]])("limit=%p becomes %i", (limit, expected) => {
    expect(paginate({ limit }, D).limit).toBe(expected);
  });

  test("a limit above the cap is clamped down, not rejected", () => {
    expect(paginate({ limit: "99999" }, D).limit).toBe(2000);
  });

  test("an unparseable limit falls back to the default", () => {
    expect(paginate({ limit: "abc" }, D).limit).toBe(500);
    expect(paginate({}, D).limit).toBe(500);
  });
});

describe("ordinary paging still works", () => {
  test.each([
    [1, 500, 0], [2, 500, 500], [3, 250, 500], [10, 100, 900],
  ])("page %i at limit %i → offset %i", (page, limit, offset) => {
    const r = paginate({ page: String(page), limit: String(limit) }, D);
    expect(r).toEqual({ limit, offset, page });
  });

  test("a negative page is the first page, not a negative offset", () => {
    expect(paginate({ page: "-3" }, D).offset).toBe(0);
  });

  // parseInt("1e9") is 1 — the exponent is silently dropped. Worth pinning: the result is a
  // valid first page rather than an error, which is the behaviour the routes have always had.
  test("exponent notation degrades to its leading digits, not to NaN", () => {
    expect(paginate({ page: "1e9" }, D).page).toBe(1);
  });

  test("each route's own defaults are respected", () => {
    expect(paginate({}, { defaultLimit: 200, maxLimit: 1000 })).toEqual({ limit: 200, offset: 0, page: 1 });
    expect(paginate({ limit: "5000" }, { defaultLimit: 200, maxLimit: 1000 }).limit).toBe(1000);
  });
});

describe("every result is safe to interpolate into SQL", () => {
  const hostile = ["1; DROP TABLE users", "1 OR 1=1", "abc", "-1", "1e9", "٣", "0x10", " 2 "];
  test.each(hostile)("page=%p and limit=%p produce plain integers", (v) => {
    const { limit, offset, page } = paginate({ page: v, limit: v }, D);
    for (const n of [limit, offset, page]) {
      expect(Number.isInteger(n)).toBe(true);
      expect(Number.isFinite(n)).toBe(true);
      expect(String(n)).toMatch(/^\d+$/);
    }
  });
});
