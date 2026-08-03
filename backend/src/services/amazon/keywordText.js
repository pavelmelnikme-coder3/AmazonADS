"use strict";

/**
 * Amazon rejects keyword text containing non-ASCII whitespace with
 *   malformedValueError / PATTERN_NOT_MATCHED ("Keyword is invalid")
 *
 * Amazon's own search-term reports hand us exactly such text: German queries
 * routinely arrive with U+00A0 (no-break space) or U+202F (narrow no-break
 * space) between a number and its unit ("150 kg"), and occasionally with a
 * zero-width space glued to the front. Negating those verbatim fails on every
 * run, forever — the rule re-matches the same term the next day and re-issues
 * the same doomed write. Observed live: "campingstuhl 150 kg" (U+00A0) failed
 * daily from 2026-07-25.
 *
 * Normalising is meaning-preserving: every code point handled here is either a
 * typographic variant of a plain space or invisible, so the resulting keyword
 * still matches the same shopper traffic.
 */

// Unicode space separators Amazon rejects but that mean "space".
const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
// Invisible formatting characters — carry no meaning inside a keyword.
const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\uFEFF]/g;
// C0/C1 control characters.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

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
 * SQL mirror of normalizeKeywordText(), for comparing against columns that
 * still hold raw Amazon text (search_term_metrics.query).
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

module.exports = { normalizeKeywordText, sqlNormalizeKeywordText };
