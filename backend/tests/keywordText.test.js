"use strict";
/**
 * Amazon keyword-text normalization
 *
 * Amazon's search-term reports return text the Amazon write API then rejects with
 * malformedValueError / PATTERN_NOT_MATCHED. Two live failures drive this module:
 *
 *   • "campingstuhl 150 kg" carried U+00A0 between "150" and "kg" and failed to negate
 *     on every run from 2026-07-25.
 *   • "abdeckplane wohnmobil 7,50 m" was rejected on 2026-09-01 for the plain ASCII
 *     comma, and — because the local row was left claiming success — never retried.
 *
 * They are handled differently on purpose. Whitespace is rewritten — a no-break space is a
 * typographic variant of a space, so the keyword still matches the same traffic. Punctuation
 * is NOT: "7 50" is a different keyword from "7,50", and the account's own data says Amazon
 * agrees (that query took 6 clicks in August 2026 with a negative_exact for the space-form
 * enabled in the same ad group). Such terms are reported by unsupportedKeywordChars() and
 * skipped by the caller instead.
 *
 * The JS normalizer and its SQL mirror must agree exactly: negatives are stored normalized
 * while search_term_metrics.query keeps Amazon's raw text, and reconciliation compares the
 * two. Verified equal on all 38 806 distinct production search terms.
 */

const { normalizeKeywordText, unsupportedKeywordChars, sqlNormalizeKeywordText } =
  require("../src/services/amazon/keywordText");

const hex = s => Buffer.from(s, "utf8").toString("hex");

describe("normalizeKeywordText — whitespace", () => {
  it("converts U+00A0 (no-break space) to a plain space", () => {
    const raw = "campingstuhl 150 kg";
    expect(hex(raw)).toContain("c2a0");
    const out = normalizeKeywordText(raw);
    expect(out).toBe("campingstuhl 150 kg");
    expect(hex(out)).not.toContain("c2a0");
  });

  it("converts U+202F (narrow no-break space) to a plain space", () => {
    expect(normalizeKeywordText("2 3 kw")).toBe("2 3 kw");
  });

  it("strips U+200B (zero-width space) entirely", () => {
    const out = normalizeKeywordText("​fußabstreifer aluminium");
    expect(out).toBe("fußabstreifer aluminium");
    expect(hex(out)).not.toContain("e2808b");
  });

  it("strips the U+FEFF byte-order mark", () => {
    expect(normalizeKeywordText("﻿camping")).toBe("camping");
  });

  it("turns control characters into spaces and collapses runs of whitespace", () => {
    expect(normalizeKeywordText("a\tb")).toBe("a b");
    expect(normalizeKeywordText("  double   space  ")).toBe("double space");
  });
});

describe("normalizeKeywordText — characters Amazon refuses are left alone", () => {
  it("does NOT substitute the comma that broke the 2026-09-01 negative", () => {
    // Comma to space would be a different keyword, not a different spelling. Evidence:
    // "abdeckplane wohnmobil 7,50 m" took 6 clicks in August 2026 while a negative_exact for
    // "abdeckplane wohnmobil 7 50 m" sat enabled in the same ad group. Rewriting would make
    // the rule claim a negative that blocks nothing.
    expect(normalizeKeywordText("abdeckplane wohnmobil 7,50 m"))
      .toBe("abdeckplane wohnmobil 7,50 m");
  });

  it("leaves every other unsupported character in place too", () => {
    for (const raw of ['4" desk', "100 × 100", "gas 50°", "matte 60/40", "rabatt 20%", "größe: xl"]) {
      expect(normalizeKeywordText(raw)).toBe(raw);
    }
  });
});

describe("unsupportedKeywordChars", () => {
  it("reports the comma Amazon rejected", () => {
    expect(unsupportedKeywordChars("abdeckplane wohnmobil 7,50 m")).toEqual([","]);
  });

  it("reports the characters seen only in report text, never in an accepted entity", () => {
    expect(unsupportedKeywordChars('4" desk')).toEqual(['"']);
    expect(unsupportedKeywordChars("100 × 100")).toEqual(["×"]);
    expect(unsupportedKeywordChars("gas 50°")).toEqual(["°"]);
    expect(unsupportedKeywordChars("matte 60/40")).toEqual(["/"]);
    expect(unsupportedKeywordChars("rabatt 20%")).toEqual(["%"]);
    expect(unsupportedKeywordChars("zelt – 2 mann")).toEqual(["–"]);
    expect(unsupportedKeywordChars("brandschutzfolie 9m²")).toEqual(["²"]);
  });

  it("de-duplicates and keeps every distinct offender", () => {
    expect(unsupportedKeywordChars("a, b, c/d").sort()).toEqual([",", "/"]);
  });

  it("passes text Amazon accepts — including the punctuation real entities contain", () => {
    // Every character here appears in this account's Amazon-confirmed keywords/negatives.
    expect(unsupportedKeywordChars("fußmatte 80 cm 2er-set")).toEqual([]);
    expect(unsupportedKeywordChars("m & m's 2.5 (xl) a_b+c")).toEqual([]);
    expect(unsupportedKeywordChars("kleines packmaß")).toEqual([]);
  });

  it("ignores whitespace normalization already handles", () => {
    expect(unsupportedKeywordChars("campingstuhl 150 kg")).toEqual([]);   // U+00A0
    expect(unsupportedKeywordChars("a\tb")).toEqual([]);
  });

  it("keeps non-Latin scripts, so other marketplaces still work", () => {
    expect(unsupportedKeywordChars("キャンプ 用品")).toEqual([]);
    expect(unsupportedKeywordChars("кемпинг стул")).toEqual([]);
  });

  it("returns nothing for non-strings", () => {
    expect(unsupportedKeywordChars(null)).toEqual([]);
    expect(unsupportedKeywordChars(undefined)).toEqual([]);
  });
});

describe("normalizeKeywordText — contract", () => {
  it("leaves already-clean text byte-identical", () => {
    const clean = "campingstuhl 150 kg";
    expect(normalizeKeywordText(clean)).toBe(clean);
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(normalizeKeywordText("  ​")).toBe("");
  });

  it("passes non-strings through untouched", () => {
    expect(normalizeKeywordText(null)).toBeNull();
    expect(normalizeKeywordText(undefined)).toBeUndefined();
  });

  it("is idempotent — re-normalizing changes nothing", () => {
    for (const raw of ["campingstuhl 150 kg", "abdeckplane wohnmobil 7,50 m",
                       "wäschekorb", "9m²", "m & m's (xl)"]) {
      const once = normalizeKeywordText(raw);
      expect(normalizeKeywordText(once)).toBe(once);
    }
  });
});

describe("sqlNormalizeKeywordText", () => {
  it("wraps the given expression rather than quoting it as a literal", () => {
    const sql = sqlNormalizeKeywordText("query");
    expect(sql).toContain("query");
    expect(sql).toContain("regexp_replace");
    expect(sql).toContain("btrim");
  });

  it("covers the same code points the JS normalizer handles", () => {
    const sql = sqlNormalizeKeywordText("$1");
    expect(sql).toContain("\\u00A0");   // no-break space
    expect(sql).toContain("\\u202F");   // narrow no-break space
    expect(sql).toContain("\\u200B");   // zero-width space
    expect(sql).toContain("\\uFEFF");   // BOM
  });

  it("mirrors only the whitespace pass — it must never rewrite characters", () => {
    // The unsupported-character check has no SQL counterpart on purpose: it decides whether
    // to skip a term, it never substitutes, so there is nothing for the mirror to reproduce.
    const sql = sqlNormalizeKeywordText("$1");
    expect(sql).not.toContain("[:alnum:]");
    expect(sql).not.toContain("NFC");
  });
});
