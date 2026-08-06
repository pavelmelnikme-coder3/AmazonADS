"use strict";
/**
 * Claude response parsing.
 *
 * The AI features were pinned to `claude-sonnet-4-20250514`, retired 2026-06-15, and had
 * been 404-ing daily since. Swapping the model alone would have replaced a loud failure
 * with a silent one: on current models thinking is on by default, so `content[0]` is a
 * `thinking` block. It carries `.thinking`, never `.text` — every call site read
 * `content[0].text`, so each would have fallen back to "" / "{}" and returned empty
 * results with nothing logged.
 */

const { MODEL, extractText, parseJsonResponse } = require("../src/services/ai/claudeClient");

describe("MODEL", () => {
  it("is a current, non-retired model id", () => {
    expect(MODEL).toBe("claude-opus-5");
  });

  it("carries no date suffix — current ids are complete as written", () => {
    expect(MODEL).not.toMatch(/-\d{8}$/);
  });
});

describe("extractText", () => {
  it("reads the text block when a thinking block comes first", () => {
    // The exact shape that broke the old content[0].text access.
    const message = {
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: '{"ok":true}' },
      ],
    };
    expect(extractText(message)).toBe('{"ok":true}');
  });

  it("reads a plain text-only response", () => {
    expect(extractText({ content: [{ type: "text", text: "hello" }] })).toBe("hello");
  });

  it("joins an answer split across several text blocks", () => {
    const message = {
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: '{"a":' },
        { type: "text", text: "1}" },
      ],
    };
    expect(extractText(message)).toBe('{"a":1}');
  });

  it("trims surrounding whitespace", () => {
    expect(extractText({ content: [{ type: "text", text: "  spaced  " }] })).toBe("spaced");
  });

  it("ignores non-text blocks entirely", () => {
    const message = {
      content: [
        { type: "thinking", thinking: "some reasoning" },
        { type: "tool_use", id: "t1", name: "x", input: {} },
        { type: "text", text: "answer" },
      ],
    };
    expect(extractText(message)).toBe("answer");
  });

  it("returns an empty string when there is no text block", () => {
    expect(extractText({ content: [{ type: "thinking", thinking: "" }] })).toBe("");
  });

  it("survives malformed or missing payloads instead of throwing", () => {
    expect(extractText(null)).toBe("");
    expect(extractText(undefined)).toBe("");
    expect(extractText({})).toBe("");
    expect(extractText({ content: null })).toBe("");
    expect(extractText({ content: "not an array" })).toBe("");
    expect(extractText({ content: [{ type: "text" }] })).toBe("");
  });
});

describe("parseJsonResponse", () => {
  it("parses JSON that sits behind a leading thinking block", () => {
    const message = {
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: '{"keywords":[{"text":"camping"}]}' },
      ],
    };
    expect(parseJsonResponse(message)).toEqual({ keywords: [{ text: "camping" }] });
  });

  it("strips a ```json fence the model wrapped the answer in", () => {
    const message = { content: [{ type: "text", text: '```json\n{"a":1}\n```' }] };
    expect(parseJsonResponse(message)).toEqual({ a: 1 });
  });

  it("strips a bare ``` fence", () => {
    const message = { content: [{ type: "text", text: '```\n[1,2]\n```' }] };
    expect(parseJsonResponse(message)).toEqual([1, 2]);
  });

  it("returns the fallback on malformed JSON rather than throwing", () => {
    const message = { content: [{ type: "text", text: "{not json" }] };
    expect(parseJsonResponse(message, [])).toEqual([]);
  });

  it("returns the fallback when the response carries no text at all", () => {
    expect(parseJsonResponse({ content: [{ type: "thinking", thinking: "" }] }, [])).toEqual([]);
  });
});
