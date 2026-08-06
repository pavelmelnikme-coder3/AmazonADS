"use strict";

/**
 * Shared Claude model choice and response parsing.
 *
 * The model was pinned to `claude-sonnet-4-20250514`, which Anthropic retired on
 * 2026-06-15. Every AI call had been failing with `404 not_found_error` since —
 * silently, because each call site catches and returns an empty result. Found in
 * the logs on 2026-08-06, failing daily at the 07:00 AI-analysis cron.
 */
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

/**
 * Pull the assistant's text out of a Messages API response.
 *
 * Do NOT read `content[0].text`. On current models thinking is on by default, so
 * the first content block is a `thinking` block — it carries `.thinking`, never
 * `.text`, so indexing [0] yields `undefined` and the caller silently falls back
 * to "" or "{}" with no error anywhere. The text block can sit at any index, and
 * long answers may arrive split across several of them, so filter and join.
 *
 * Accepts either an SDK message object or a raw HTTP response body — both carry
 * the same `content` array.
 */
function extractText(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter(b => b?.type === "text" && typeof b.text === "string")
    .map(b => b.text)
    .join("")
    .trim();
}

/**
 * Strip a markdown code fence the model may have wrapped JSON in, then parse.
 * Returns `fallback` rather than throwing so a malformed answer degrades to an
 * empty result instead of taking down the caller.
 */
function parseJsonResponse(message, fallback = null) {
  const text = extractText(message);
  if (!text) return fallback;
  const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    return fallback;
  }
}

module.exports = { MODEL, extractText, parseJsonResponse };
