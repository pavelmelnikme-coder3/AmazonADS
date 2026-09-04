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
 * The JS normalizer and its SQL mirror must agree exactly: negatives are stored
 * normalized while search_term_metrics.query keeps Amazon's raw text, and reconciliation
 * compares the two. Verified equal on all 38 806 distinct production search terms.
 */

const { normalizeKeywordText, needsKeywordNormalization, sqlNormalizeKeywordText } =
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

describe("normalizeKeywordText — characters Amazon refuses", () => {
  it("replaces the comma that broke the 2026-09-01 negative", () => {
    expect(normalizeKeywordText("abdeckplane wohnmobil 7,50 m"))
      .toBe("abdeckplane wohnmobil 7 50 m");
  });

  it("replaces with a space rather than deleting, so digits stay separate", () => {
    // Deleting would produce "750" and silently negate a different number.
    expect(normalizeKeywordText("7,50")).toBe("7 50");
  });

  it("replaces the other characters seen only in report text, never in accepted entities", () => {
    expect(normalizeKeywordText('4" desk')).toBe("4 desk");          // amzn/ads-advanced-tools-docs#143
    expect(normalizeKeywordText("100 × 100")).toBe("100 100");
    expect(normalizeKeywordText("gas 50°")).toBe("gas 50");
    expect(normalizeKeywordText("matte 60/40")).toBe("matte 60 40");
    expect(normalizeKeywordText("rabatt 20%")).toBe("rabatt 20");
    expect(normalizeKeywordText("größe: xl")).toBe("größe xl");
    expect(normalizeKeywordText("zelt – 2 mann")).toBe("zelt 2 mann");
  });

  it("drops superscripts and fractions, which Postgres [:alnum:] also drops", () => {
    expect(normalizeKeywordText("brandschutzfolie b1 9m²")).toBe("brandschutzfolie b1 9m");
    expect(normalizeKeywordText("selbstklebend⁸")).toBe("selbstklebend");
  });
});

describe("normalizeKeywordText — characters Amazon accepts", () => {
  it("preserves German letters and the punctuation real Amazon entities contain", () => {
    // Every character here appears in this account's Amazon-confirmed keywords/negatives.
    expect(normalizeKeywordText("fußmatte 80 cm 2er-set")).toBe("fußmatte 80 cm 2er-set");
    expect(normalizeKeywordText("kleines packmaß")).toBe("kleines packmaß");
    expect(normalizeKeywordText("m & m's 2.5 (xl) a_b+c")).toBe("m & m's 2.5 (xl) a_b+c");
  });

  it("keeps non-Latin scripts, so other marketplaces still work", () => {
    expect(normalizeKeywordText("キャンプ 用品")).toBe("キャンプ 用品");
    expect(normalizeKeywordText("кемпинг стул")).toBe("кемпинг стул");
  });
});

describe("normalizeKeywordText — Unicode form", () => {
  it("precomposes a decomposed umlaut instead of stripping the mark off it", () => {
    const decomposed = "wäschekorb";           // a + combining diaeresis
    expect(decomposed).not.toBe("wäschekorb");
    expect(normalizeKeywordText(decomposed)).toBe("wäschekorb");
  });

  it("deletes a combining mark that has no precomposed form, without splitting the token", () => {
    // U+05C1 on a letter that cannot absorb it — seen live on one search term.
    expect(normalizeKeywordText("abcׁdef")).toBe("abcdef");
  });
});

describe("normalizeKeywordText — contract", () => {
  it("leaves already-clean text byte-identical", () => {
    const clean = "campingstuhl 150 kg";
    expect(normalizeKeywordText(clean)).toBe(clean);
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(normalizeKeywordText("  ​")).toBe("");
    expect(normalizeKeywordText(",,,")).toBe("");
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

describe("needsKeywordNormalization", () => {
  it("flags text Amazon would reject", () => {
    expect(needsKeywordNormalization("abdeckplane wohnmobil 7,50 m")).toBe(true);
    expect(needsKeywordNormalization("campingstuhl 150 kg")).toBe(true);
  });

  it("leaves acceptable text unflagged", () => {
    expect(needsKeywordNormalization("campingstuhl 150 kg")).toBe(false);
    expect(needsKeywordNormalization(null)).toBe(false);
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

  it("mirrors the character allow-list and the NFC + combining-mark passes", () => {
    const sql = sqlNormalizeKeywordText("$1");
    expect(sql).toContain("normalize($1, NFC)");     // precomposition, as in JS
    expect(sql).toContain("[^[:alnum:] ''()_+&.-]"); // the allow-list, doubled quote for SQL
    expect(sql).toContain("\\u0300-\\u036F");        // combining marks
  });
});
