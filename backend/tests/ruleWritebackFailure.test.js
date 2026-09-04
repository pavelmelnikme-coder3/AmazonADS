"use strict";
/**
 * A negative the rule created locally but Amazon refused must not be left claiming success.
 *
 * Live failure (2026-09-01): the rule negated "abdeckplane wohnmobil 7,50 m", Amazon answered
 * malformedValueError / PATTERN_NOT_MATCHED, and the local row stayed state='enabled' carrying
 * a synthetic "rule-…" id. From then on:
 *   • every later run skipped the term as `already_negative`;
 *   • reconciliation only asks "is this negative still justified by the metrics", never
 *     "does it exist on Amazon";
 *   • no sync could correct it, because a synthetic id matches nothing Amazon returns.
 * So the term kept spending with nothing blocking it, nothing retrying, and nothing reporting.
 *
 * These cover the two halves of the fix: classifying a rejection as permanent vs transient,
 * and condensing skip reasons + Amazon rejections into the persisted run diagnostics.
 */

jest.mock("../src/db/pool", () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { isPermanentWritebackError, summarizeRunDiagnostics } = require("../src/routes/rules").__test;

describe("isPermanentWritebackError", () => {
  it("treats a malformed-value rejection as permanent — the same text fails again tomorrow", () => {
    const live = '{"errors":[{"errorType":"malformedValueError","errorValue":{"malformedValueError":'
      + '{"cause":{},"message":"Keyword is invalid","reason":"PATTERN_NOT_MATCHED"}}}],"index":0}';
    expect(isPermanentWritebackError(live)).toBe(true);
  });

  it("treats the other input-shaped rejections as permanent", () => {
    expect(isPermanentWritebackError("INVALID_ARGUMENT: expressionType")).toBe(true);
    expect(isPermanentWritebackError("Match type NOT_SUPPORTED for this campaign")).toBe(true);
    expect(isPermanentWritebackError("UNSUPPORTED expression type")).toBe(true);
  });

  it("treats outages and throttling as transient, so the next run retries", () => {
    // The 2026-06 access incident was entirely 401s — those must never become permanent.
    expect(isPermanentWritebackError('Amazon API error: 401 {"message":"Unauthorized exception"}')).toBe(false);
    expect(isPermanentWritebackError("Amazon API error: 429 Too Many Requests")).toBe(false);
    expect(isPermanentWritebackError("Amazon API error: 500 Internal Server Error")).toBe(false);
    expect(isPermanentWritebackError("timeout of 90000ms exceeded")).toBe(false);
    expect(isPermanentWritebackError("socket hang up")).toBe(false);
  });

  it("treats a duplicate as transient — the negative exists, so recovery should be retried", () => {
    expect(isPermanentWritebackError("duplicateValueError: already exists")).toBe(false);
    expect(isPermanentWritebackError("DUPLICATE_VALUE")).toBe(false);
  });

  it("is false for no error at all", () => {
    expect(isPermanentWritebackError(null)).toBe(false);
    expect(isPermanentWritebackError(undefined)).toBe(false);
    expect(isPermanentWritebackError("")).toBe(false);
  });
});

describe("summarizeRunDiagnostics", () => {
  it("explains a run that matched entities and changed none", () => {
    // The live shape of the budget rule: 30 matched, 0 applied, previously stored as an
    // empty summary with no reason anywhere.
    const result = {
      applied: [],
      skipped: Array.from({ length: 30 }, (_, i) => ({
        entity_type: "campaign", campaign_name: `Campaign ${i}`,
        action: "adjust_budget_pct", reason: "budget_not_binding",
        detail: { daily_budget: 200, budget_limited_days: 0, required_days: 2 },
      })),
    };
    const d = summarizeRunDiagnostics(result);
    expect(d.skipped_by_reason).toEqual({ budget_not_binding: 30 });
    expect(d.skipped_samples.budget_not_binding).toHaveLength(5); // capped
    expect(d.skipped_samples.budget_not_binding[0]).toMatchObject({
      entity_type: "campaign", keyword_text: "Campaign 0", action: "adjust_budget_pct",
    });
  });

  it("counts every reason separately", () => {
    const d = summarizeRunDiagnostics({
      skipped: [
        { reason: "already_paused", entity_type: "keyword", keyword_text: "a" },
        { reason: "already_paused", entity_type: "keyword", keyword_text: "b" },
        { reason: "already_negative", entity_type: "search_term", keyword_text: "c" },
      ],
    });
    expect(d.skipped_by_reason).toEqual({ already_paused: 2, already_negative: 1 });
  });

  it("carries the Amazon message for a term that cannot be negated", () => {
    const d = summarizeRunDiagnostics({
      skipped: [{
        reason: "amazon_rejected_keyword_text", entity_type: "search_term",
        keyword_text: "abdeckplane wohnmobil 7,50 m", action: "add_negative_keyword",
        detail: { amazon_error: "Keyword is invalid / PATTERN_NOT_MATCHED" },
      }],
    });
    expect(d.skipped_samples.amazon_rejected_keyword_text[0].amazon_error)
      .toContain("PATTERN_NOT_MATCHED");
  });

  it("keeps Amazon rejections, which never reach `errors`", () => {
    const d = summarizeRunDiagnostics({
      writeback_errors: [{ action: "add_negative_keyword", error: "PATTERN_NOT_MATCHED" }],
      errors: [{ stage: "local", error: "boom" }],
    });
    expect(d.writeback_errors).toHaveLength(1);
    expect(d.errors).toHaveLength(1);
  });

  it("caps unbounded lists so a 20 000-entity run cannot bloat the row", () => {
    const d = summarizeRunDiagnostics({
      writeback_errors: Array.from({ length: 200 }, () => ({ error: "x" })),
      errors:           Array.from({ length: 200 }, () => ({ error: "y" })),
    });
    expect(d.writeback_errors).toHaveLength(25);
    expect(d.errors).toHaveLength(25);
  });

  it("handles a clean run and a missing result without throwing", () => {
    expect(summarizeRunDiagnostics({ applied: [{}], skipped: [] })).toEqual({
      skipped_by_reason: {}, skipped_samples: {}, writeback_errors: [], errors: [],
    });
    expect(summarizeRunDiagnostics(undefined).skipped_by_reason).toEqual({});
  });

  it("labels a skip with no reason rather than dropping it", () => {
    const d = summarizeRunDiagnostics({ skipped: [{ entity_type: "keyword" }] });
    expect(d.skipped_by_reason).toEqual({ unknown: 1 });
  });
});
