"use strict";
/**
 * Amazon keyword-text normalization
 *
 * Amazon's search-term reports return text containing typographic whitespace that the
 * Amazon write API then rejects with malformedValueError / PATTERN_NOT_MATCHED. Live
 * example: "campingstuhl 150 kg" arrived with U+00A0 between "150" and "kg" and failed
 * to negate on every run from 2026-07-25 onwards.
 */

const { normalizeKeywordText, sqlNormalizeKeywordText } =
  require("../src/services/amazon/keywordText");

const hex = s => Buffer.from(s, "utf8").toString("hex");

describe("normalizeKeywordText", () => {
  it("converts U+00A0 (no-break space) to a plain space", () => {
    const raw = "campingstuhl 150 kg";
    expect(hex(raw)).toContain("c2a0");
    const out = normalizeKeywordText(raw);
    expect(out).toBe("campingstuhl 150 kg");
    expect(hex(out)).not.toContain("c2a0");
  });

  it("converts U+202F (narrow no-break space) to a plain space", () => {
    expect(normalizeKeywordText("2,3 kw")).toBe("2,3 kw");
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

  it("preserves German letters, digits and ordinary punctuation", () => {
    expect(normalizeKeywordText("fußmatte 80 cm, 2er-set")).toBe("fußmatte 80 cm, 2er-set");
    expect(normalizeKeywordText("kleines packmaß")).toBe("kleines packmaß");
  });

  it("leaves already-clean text byte-identical", () => {
    const clean = "campingstuhl 150 kg";
    expect(normalizeKeywordText(clean)).toBe(clean);
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(normalizeKeywordText("  ​")).toBe("");
  });

  it("passes non-strings through untouched", () => {
    expect(normalizeKeywordText(null)).toBeNull();
    expect(normalizeKeywordText(undefined)).toBeUndefined();
  });

  it("is idempotent", () => {
    const once  = normalizeKeywordText("campingstuhl 150 kg");
    expect(normalizeKeywordText(once)).toBe(once);
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
});
