"use strict";

/**
 * Amazon rejects keyword text containing characters outside its accepted set with
 *   malformedValueError / PATTERN_NOT_MATCHED ("Keyword is invalid")
 *
 * Amazon's own search-term reports hand us exactly such text, in two kinds — and the two are
 * treated very differently here.
 *
 * -- 1. Typographic whitespace: rewritten ------------------------------------
 * German queries routinely arrive with U+00A0 (no-break space) or U+202F (narrow no-break
 * space) between a number and its unit ("150 kg"), and occasionally with a zero-width space
 * glued to the front. Observed live: "campingstuhl 150 kg" (U+00A0) failed to negate on every
 * run from 2026-07-25.
 *
 * Every code point handled there is a typographic variant of a plain space, or invisible.
 * Replacing it is meaning-preserving: the keyword still matches the same shopper traffic, so
 * the normalized form is what gets stored and sent.
 *
 * -- 2. Punctuation Amazon will not take: NOT rewritten -----------------------
 * Observed live: "abdeckplane wohnmobil 7,50 m" was rejected on 2026-09-01 for the plain ASCII
 * comma. It is tempting to fix that the same way — comma to space — but that is a different
 * keyword, not a different spelling of the same one, and the evidence says Amazon treats it as
 * such: the query took 6 clicks in August while a negative_exact for
 * "abdeckplane wohnmobil 7 50 m" sat enabled in the very same ad group, untouched by AdsFlow.
 * A rewrite would have the rule report a negative as applied while the term kept spending, and
 * then skip it forever as `already_negative` — precisely the silent failure this module exists
 * to prevent.
 *
 * So text still carrying unsupported characters after whitespace normalization is reported by
 * `unsupportedKeywordChars()` and skipped by the caller, surfacing the term for manual
 * handling instead of guessing at a substitute.
 *
 * The accepted set is derived empirically from what this account's own Amazon-confirmed
 * entities contain (~40k rows: every keyword carrying a real Amazon id, plus every negative
 * that came back from a sync). Amazon documents a "valid keyword characters" list, but it is
 * known to be wrong — amzn/ads-advanced-tools-docs#143 reports the API rejecting a double
 * quote the docs call valid.
 *
 *     letters (incl. a-umlaut, o-umlaut, u-umlaut, sharp s) - digits - space - hyphen + & . \' _ ( )
 *
 * Characters seen only in report text and never in an accepted entity: , / " x-times deg % : en-dash
 *
 * The list is a best effort — it cannot know about a character this account has never used.
 * That is why a rejected write-back is also made self-healing rather than trusted (see
 * writeback_error handling in routes/rules.js).
 */

// Unicode space separators Amazon rejects but that mean "space".
const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
// Invisible formatting characters — carry no meaning inside a keyword.
const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\uFEFF]/g;
// C0/C1 control characters.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
// Characters outside the empirically accepted set (see header). Unicode letters and decimal
// digits are allowed wholesale so non-German marketplaces keep working. \p{Nd} rather than
// \p{N}: the latter also covers superscripts and fractions, which Amazon has never accepted here.
const UNSUPPORTED = /[^\p{L}\p{Nd} '()_+&.\-]/gu;

/**
 * Make search-term text safe to send to the Amazon Ads API.
 * Non-strings pass through untouched so callers can use it defensively.
 */
function normalizeKeywordText(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(ZERO_WIDTH, "")
    .replace(CONTROL, " ")
    .replace(UNICODE_SPACES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The distinct characters in `text` that Amazon will not accept and that normalization cannot
 * safely remove. An empty array means the text is safe to send.
 *
 * Callers skip such a term rather than substituting — see the header for why a substitute
 * would be a different keyword.
 */
function unsupportedKeywordChars(text) {
  if (typeof text !== "string") return [];
  return [...new Set(normalizeKeywordText(text).match(UNSUPPORTED) || [])];
}

/**
 * SQL mirror of normalizeKeywordText(), for comparing against columns that
 * still hold raw Amazon text (search_term_metrics.query).
 *
 * MUST stay byte-for-byte equivalent to the JS version: negatives are stored
 * normalized, and reconciliation looks their metrics back up by comparing this
 * expression against the raw report text. A mismatch means the reconcile finds no
 * rows, reads the term as "0 clicks", and mismanages the negative.
 *
 * It deliberately mirrors only the whitespace pass. The unsupported-character check has no
 * SQL counterpart because it never rewrites anything — it only decides whether to skip.
 * Verified equal on all 38 806 distinct search-term queries in production.
 *
 * `expr` is interpolated into SQL, so it must be a caller-controlled column
 * reference or placeholder — never user input.
 */
function sqlNormalizeKeywordText(expr) {
  return "btrim(regexp_replace(regexp_replace(regexp_replace("
    + expr
    + ", '[\\u200B\\u200C\\u200D\\u2060\\uFEFF]', '', 'g')"
    + ", '[\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]', ' ', 'g')"
    + ", '\\s+', ' ', 'g'))";
}

module.exports = { normalizeKeywordText, unsupportedKeywordChars, sqlNormalizeKeywordText };
