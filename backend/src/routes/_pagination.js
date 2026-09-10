/**
 * One place to turn `?page=` / `?limit=` into numbers that are safe to put in SQL.
 *
 * The three list routes each carried their own copy of
 *
 *     const limit  = Math.min(parseInt(rawLimit) || 500, 2000);
 *     const offset = (Math.max(parseInt(page), 1) - 1) * limit;
 *
 * and both lines interpolate straight into `LIMIT ${limit} OFFSET ${offset}`. Neither survives
 * input that is not a number:
 *
 *   ?page=abc   parseInt → NaN, and Math.max(NaN, 1) is NaN, not 1 — so the offset is NaN and
 *               Postgres answers `ERROR: column "nan" does not exist`. A 500, not a 400.
 *   ?limit=-5   parseInt → -5, which is truthy, so `|| 500` never fires and the clamp only caps
 *               the top end: `ERROR: LIMIT must not be negative`.
 *
 * Both were verified against the live database. Interpolation itself is not the problem — these
 * are numbers, never user text — but only once they really are numbers.
 */

/**
 * @param {object} query - req.query
 * @param {object} opts
 * @param {number} opts.defaultLimit
 * @param {number} opts.maxLimit
 * @returns {{ limit:number, offset:number, page:number }} all finite integers ≥ their floor
 */
function paginate(query = {}, { defaultLimit = 100, maxLimit = 1000 } = {}) {
  const asInt = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  const rawLimit = asInt(query.limit);
  // A missing or unparseable limit takes the default; anything else is clamped into range, so a
  // negative or zero limit becomes 1 rather than reaching SQL.
  const limit = rawLimit == null ? defaultLimit : Math.min(Math.max(rawLimit, 1), maxLimit);
  const page = Math.max(asInt(query.page) ?? 1, 1);
  return { limit, offset: (page - 1) * limit, page };
}

/**
 * Just the page number, for routes that compute their own limit from an allow-list and only need
 * the offset arithmetic made safe. Same rule: anything unparseable is page 1.
 *
 * `Math.max(parseInt(v), 1)` looks like it does this and does not — Math.max(NaN, 1) is NaN.
 */
function pageNumber(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** A positive integer limit, for routes that take one straight from the query string. */
function limitNumber(v, fallback, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 1), max);
}

module.exports = { paginate, pageNumber, limitNumber };
