"use strict";

/**
 * Amazon rejects keyword text containing characters outside its accepted set with
 *   malformedValueError / PATTERN_NOT_MATCHED ("Keyword is invalid")
 *
 * Amazon's own search-term reports hand us exactly such text, in two flavours.
 *
 * 1. Typographic whitespace. German queries routinely arrive with U+00A0 (no-break
 *    space) or U+202F (narrow no-break space) between a number and its unit
 *    ("150 kg"), and occasionally with a zero-width space glued to the front.
 *    Observed live: "campingstuhl 150 kg" (U+00A0) failed daily from 2026-07-25.
 *
 * 2. Punctuation Amazon will not take. Observed live: "abdeckplane wohnmobil 7,50 m"
 *    was rejected on 2026-09-01 for the plain ASCII comma. 171 distinct search-term
 *    queries in the preceding 60 days contained one, so this recurs.
 *
 * Negating such text verbatim fails on every run, forever — and, worse, the local row
 * is left claiming the term is blocked when it is not.
 *
 * ── Why an allow-list, and why this one ──────────────────────────────────────
 * Amazon documents a "valid keyword characters" list, but it is known to be wrong:
 * amzn/ads-advanced-tools-docs#143 reports the API rejecting a double quote the docs
 * call valid. So the set below is derived empirically from what this account's own
 * Amazon-confirmed entities actually contain — every keyword carrying a real Amazon id
 * plus every negative that came back from a sync (≈40k rows):
 *
 *     letters (incl. ä ö ü ß ã ı) · digits · space · - + & . ' _ ( )
 *
 * and nothing else. Characters seen only in *report* text and never in an accepted
 * entity — , / " × ° % : – — are the ones that get replaced here.
 *
 * Replacement is a space, not deletion: "7,50" must become "7 50", not "750".
 * Amazon normalises punctuation on both sides when it evaluates a match, so the
 * space-separated form still blocks the same traffic; deleting would silently retarget
 * the negative at a different number.
 *
 * The allow-list is a best effort, not a guarantee — it cannot know about a character
 * this account has simply never used. That is why a rejected write-back is also made
 * self-healing rather than silently trusted (see writeback_error handling in
 * routes/rules.js).
 */

// Unicode space separators Amazon rejects but that mean "space".
const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
// Invisible formatting characters — carry no meaning inside a keyword.
const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\uFEFF]/g;
// C0/C1 control characters.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
// Combining marks surviving NFC. Postgres counts these as [:alnum:] while JS
// \p{L}\p{Nd} does not, so both normalizers strip them explicitly to stay in step —
// live example: one search term carries a stray U+05C1 Hebrew point.
const COMBINING_MARKS = /\p{M}/gu;
// Anything outside the empirically accepted set (see header). Unicode letters and
// decimal digits are kept wholesale so non-German marketplaces keep working.
//
// \p{Nd} rather than \p{N}: the latter also covers superscripts and fractions (² ⁸ ½),
// which Amazon has never accepted here and which Postgres `[:alnum:]` drops — keeping
// them would put the JS and SQL normalizers out of step on terms like "9m²".
const UNSUPPORTED = /[^\p{L}\p{Nd} '()_+&.\-]/gu;

/**
 * Make search-term text safe to send to the Amazon Ads API.
 * Non-strings pass through untouched so callers can use it defensively.
 */
function normalizeKeywordText(text) {
  if (typeof text !== "string") return text;
  return text
    // Precompose first: reports sometimes carry a decomposed "a" + U+0308. Without this
    // the mark-stripping pass below would turn "waeschekorb" into an umlaut-less word.
    .normalize("NFC")
    .replace(ZERO_WIDTH, "")
    .replace(CONTROL, " ")
    .replace(UNICODE_SPACES, " ")
    // Marks left over after NFC are deleted, not spaced — a stray combining mark belongs
    // to the letter before it, so letter + mark must stay a single token.
    .replace(COMBINING_MARKS, "")
    .replace(UNSUPPORTED, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when normalisation would change the text, i.e. Amazon would have rejected the
 * original. Used for reporting only — callers negate the normalized form either way.
 */
function needsKeywordNormalization(text) {
  return typeof text === "string" && normalizeKeywordText(text) !== text;
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
 * Postgres `[:alnum:]` is Unicode-aware on this UTF-8 database (verified: ä ö ü ß are
 * kept, × ° / " are not), which makes it the counterpart of JS `\p{L}\p{Nd}`.
 * Verified equal on all 38 806 distinct search-term queries in production.
 *
 * `expr` is interpolated into SQL, so it must be a caller-controlled column
 * reference or placeholder — never user input.
 */
function sqlNormalizeKeywordText(expr) {
  return "btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(normalize("
    + expr
    + ", NFC)"
    + ", '[\\u200B\\u200C\\u200D\\u2060\\uFEFF]', '', 'g')"
    + ", '[\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]', ' ', 'g')"
    // Combining marks left after NFC — see COMBINING_MARKS above. The explicit ranges
    // stand in for \p{M}, which Postgres regex has no equivalent of.
    + ", '[\\u0300-\\u036F\\u0483-\\u0489\\u0591-\\u05BD\\u05BF\\u05C1\\u05C2\\u05C4\\u05C5\\u05C7"
    + "\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u06D6-\\u06DC\\u0E31\\u0E34-\\u0E3A\\u0F71-\\u0F84"
    + "\\u20D0-\\u20F0\\uFE20-\\uFE2F]', '', 'g')"
    + ", '[^[:alnum:] ''()_+&.-]', ' ', 'g')"
    + ", '\\s+', ' ', 'g'))";
}

module.exports = { normalizeKeywordText, needsKeywordNormalization, sqlNormalizeKeywordText };
